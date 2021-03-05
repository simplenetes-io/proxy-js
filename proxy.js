/**
 * Simplenetes proxy JS version.
 */

const fs = require("fs");
const path = require("path");
const {TCPServer, TCPClient} = require("@universe-ai/pocket-sockets");

const LOGLEVEL = ( (process ? process.env : window) || {} ).LOG_LEVEL || "info";

function output(prefix, data)
{
    if (typeof data === "object") {
        data = JSON.stringify(data, null, 4);
    }
    console.error(`${prefix} ${data}`);
}

function logDebug(...args)
{
    if (["debug"].indexOf(LOGLEVEL) > -1 ) {
        args.forEach( msg => output("[DEBUG]", msg) );
    }
}
/* Info level */
function log(...args)
{
    if (["info", "debug"].indexOf(LOGLEVEL) > -1 ) {
        args.forEach( msg => output("[INFO ]", msg) );
    }
}

function logWarn(...args)
{
    if (["warn", "info", "debug"].indexOf(LOGLEVEL) > -1 ) {
        args.forEach( msg => output("[WARN ]",  msg) );
    }
}

function logError(...args)
{
    args.forEach( msg => output("[ERROR]", msg) );
}

/**
 * @type mapping
 * maxConn: <number>,
 * activeConnections: <number>,
 * hostPort: <number>,
 * clusterPort: <number>,
 * sendProxy: <boolean>
 *
 * @type HostAddress
 * array<host: <string>, port: <number>>
 *
 */

class Proxy
{
    /* Start a Proxy instance.
     *
     * @param {string | null} proxyConf path to proxy.conf
     *
     * The proxy.conf, the values below are the default values if not specified:
     * portsConf ./portmappings.conf
     * hostsConf ./hosts.conf
     * host 0.0.0.0
     * port 32767
     * clusterPorts 1024-29999,32768-65535
     */
    constructor(proxyConf)
    {
        this.proxyConf = path.resolve(process.cwd(), proxyConf || "./proxy.conf");

        this.config = {
            PORTSCONF: "./portmappings.conf",
            HOSTSCONF: "./hosts.conf",
            HOST: "0.0.0.0",
            //PODHOST: "",  // This can be set to have a different host for when connecting to host ports
            PORT: 32767,
            CLUSTERPORTS: "1024-29999,32768-65535"
        };

        /** @type {HostAddress[]} */
        this.hostList               = [];
        /** @type {mapping[]} */
        this.clusterPortsMappings   = [];
        this.proxyListener          = null
        this.clusterPortListeners   = null;

        log(`Loading conf file: ${this.proxyConf}`);
        this._readProxyConfig(this.proxyConf);

        this.portsConfFilepath = path.resolve(path.dirname(this.proxyConf), this.config.PORTSCONF);
        this.hostsConfFilepath = path.resolve(path.dirname(this.proxyConf), this.config.HOSTSCONF);

        log(`Loading ports conf file: ${this.portsConfFilepath}`);
        if (!this._readClusterPortsConf()) {
            logWarn(`Could not find ports conf file ${this.portsConfFilepath}`);
        }

        log(`Loading hosts conf file: ${this.hostsConfFilepath}`);
        if (!this._readHostsConf()) {
            logWarn(`Could not find hosts conf file ${this.hostsConfFilepath}`);
        }

        this._openProxyListener();
        this._openClusterPortListeners();

        this.isShutdown = false;
        this._loop();
    }

    _readProxyConfig(filepath)
    {
        let data;
        try {
            data = fs.readFileSync(filepath, {encoding: "utf8", flag: "r"});
        }
        catch(e) {
            logError(e);
            throw `Could not read config file ${filepath}`;
        }

        const lines = data.split("\n").map( line => line.trim() );

        const o = {};
        lines.forEach( line => {
            try {
                if (!line || line.startsWith("#")) {
                    return;
                }
                const key   = line.match("^([A-Za-z0-9_]+)[ ]")[1].toUpperCase();
                const value = line.match("^[^ ]+[ ]+(.*)$")[1];
                if (!key || !value) {
                    throw "Cannot parse line";
                }
                if (key === "PORT") {
                    value = parseInt(value);
                }
                this.config[key] = value.trim();
            }
            catch(e) {
                logWarn(`Unknown line in config file: ${line}`);
                /* Ignore */
            }
        });
    }

    shutdown()
    {
        if (this.isShutdown) {
            return;
        }
        this.isShutdown = true;
        this.proxyListener.close();
        this.clusterPortListeners.map( listener => listener.close() );
    }

    _loop()
    {
        if (this.isShutdown) {
            return;
        }

        this._readHostsConf();
        this._readClusterPortsConf();

        setTimeout( () => this._loop(), 5000);
    }

    _readHostsConf()
    {
        let data;
        try {
            data = fs.readFileSync(this.hostsConfFilepath, {encoding: "utf8", flag: "r"});
        }
        catch(e) {
            logDebug(`Could not read hosts conf file ${this.hostsConfFilepath}`);
            return false;
        }

        const lines = data.split("\n").map( line => line.trim() );

        const hosts = [];

        lines.forEach( line => {
            if (!line) {
                return;
            }
            try {
                const addressTuple = line.split(":");
                if (addressTuple.length < 2) {
                    return;
                }
                const hostAddress = [
                    addressTuple[0],
                    parseInt(addressTuple[1])
                ];
                hosts.push(hostAddress);
            }
            catch(e) {
                logError("Could not parse hosts conf file properly", e);
            }
        });

        this.hostList = hosts;

        return true;
    }

    _readClusterPortsConf()
    {
        let data;
        try {
            data = fs.readFileSync(this.portsConfFilepath, {encoding: "utf8", flag: "r"});
        }
        catch(e) {
            logDebug(`Could not read ports conf file ${this.portsConfFilepath}`);
            return false;
        }

        const lines = data.split("\n").map( line => line.trim() );

        const mappings = [];

        lines.forEach( line => {
            if (!line) {
                return;
            }
            try {
                const items = line.split(" ");
                items.forEach( item => {
                    if (!item) {
                        return;
                    }
                    const quadruple = item.split(":");
                    if (quadruple.length < 4) {
                        return;
                    }
                    const [clusterPort, hostPort, maxConn, sendProxy] = quadruple;
                    const mapping = {
                        maxConn: parseInt(maxConn),
                        hostPort: parseInt(hostPort),
                        clusterPort: parseInt(clusterPort),
                        sendProxy: sendProxy === "true",
                        activeConnections: 0
                    };
                    mappings.push(mapping);
                });
            }
            catch(e) {
                logError("Could not parse ports conf file properly", e);
            }
        });

        this.clusterPortsMappings = mappings;

        return true;
    }

    /**
     * Open a range of listener ports on this host which are the cluster ports.
     */
    _openClusterPortListeners()
    {
        const ports = {};
        const clusterPorts = this.config.CLUSTERPORTS || "";
        log(`Listen to cluster ports: ${clusterPorts}`);
        const a = clusterPorts.split(",");
        a.forEach( item => {
            if (item.indexOf("-") > -1) {
                /* Port ranges */
                const b = item.split("-");
                for (let i = parseInt(b[0]); i<=parseInt(b[1]); i++) {
                    ports[i] = true;
                }
            }
            else {
                /* Single port */
                ports[parseInt(item)] = true;
            }
        });

        const uniquePorts = Object.keys(ports).map( Number );

        this.clusterPortListeners = uniquePorts.map( port => {
            try {
                const config = {
                    host: this.config.HOST,
                    port: port
                };
                const clusterPortListener = new TCPServer(config);
                clusterPortListener.listen();
                clusterPortListener.onConnection( clusterPortSocket => this._handleClusterPortConnection(clusterPortSocket, port) );
                return clusterPortListener;
            }
            catch(e) {
                logError(`Could not listen to cluster port ${this.config.HOST}:${port}`);
            }

            return null;
        }).filter( listener => listener !== null );
    }

    /**
     * Open the single proxy listener.
     */
    _openProxyListener()
    {
        try {
            const config = {
                host: this.config.HOST,
                port: this.config.PORT
            };
            log(`Open Proxy listener ${this.config.HOST}:${this.config.PORT}`);
            this.proxyListener = new TCPServer(config);
            this.proxyListener.listen();
            this.proxyListener.onConnection( proxyServerSocket => this._handleProxyConnection(proxyServerSocket) );
        }
        catch(e) {
            logError(`Could not listen to proxy port ${this.config.HOST}:${port}`);
            throw `Could not start proxy`;
        }
    }

    /**
     * Handle incoming connection from other Proxy.
     * Read proxy protocol header and see if we have such a cluster port mapping locally.
     *
     * @param {AbstractClientSocket} proxyServerSocket
     */
    async _handleProxyConnection(proxyServerSocket)
    {
        logDebug(`Proxy connection incoming`);

        const INITIAL       = 1;
        const READY         = 3;

        const buffered      = [];
        let stage           = INITIAL;
        let serverSocket    = null;

        proxyServerSocket.onData( async (data) => {
            buffered.push(data);

            if (stage === INITIAL) {
                const header = await this._parseHeader(buffered);
                if (header === null) {
                    /* Await more data */
                    logDebug("Await more data on proxy socket to determine header");
                    return;
                }
                if (header === "") {
                    /* ERROR: No header present, so cannot continue */
                    logError("Proxy incoming socket could not read header data");
                    proxyServerSocket.disconnect();
                    return;
                }
                /* Extract ClusterPort from the header */
                let clusterPort = null;
                try {
                    logDebug("Read header from incoming proxy connection:", header);
                    clusterPort = parseInt(header.match("^PROXY TCP4 [^ ]+ [^ ]+ [^ ]+ ([^ ]+)")[1]);
                }
                catch(e) {
                    logError("Could not parse header from incoming proxy socket:", e);
                    proxyServerSocket.disconnect();
                    return;
                }

                logDebug(`Extracted from proxy header the cluster port: ${clusterPort}`);

                const mappings = this._findClusterPortMappings(clusterPort);
                if (mappings.length === 0) {
                    logDebug(`No mapping found for cluster port: ${clusterPort}`);
                    proxyServerSocket.disconnect();
                    return;
                }

                let index;
                let busy            = false;
                let mapping         = null;
                for (index=0; index<mappings.length; index++) {
                    mapping = mappings[index];
                    if (mapping.activeConnections >= mapping.maxConn) {
                        /* Mark that there is (at least) one but it is busy */
                        busy = true;
                        mapping = null;
                        continue;
                    }
                    serverSocket = await this._openHostPort(mapping.hostPort);
                    if (!serverSocket) {
                        logError("Could not connect to host port");
                        mapping = null;
                        continue;
                    }
                    /* Successful connection, break here and keep mapping object as it is */
                    break;
                }

                if (mapping) {
                    logDebug("Found mapping:", mapping);
                    /* Pair the sockets */
                    mapping.activeConnections++;

                    proxyServerSocket.onDisconnect( () => {
                        mapping.activeConnections--;
                        serverSocket.disconnect();
                    });

                    serverSocket.onDisconnect( () => {
                        proxyServerSocket.disconnect();
                    });

                    serverSocket.onData( data => {
                        proxyServerSocket.send(data);
                    });

                    stage = READY;
                    proxyServerSocket.send(Buffer.from(`SENDPROXY=${mapping.sendProxy}\r\n`));
                    /* Fall through to next stage */
                }
                else if (busy) {
                    logDebug(`Cluster port ${clusterPort} is busy`);
                    proxyServerSocket.send(Buffer.from("BUSY\r\n"));
                    proxyServerSocket.disconnect();
                }
                else {
                    /* No pod here mapped for the cluster port requested */
                    proxyServerSocket.disconnect();
                }

            }
            if (stage === READY) {
                while (buffered.length > 0) {
                    serverSocket.send(buffered.shift());
                }
            }
        });
    }

    /**
     * Look into the ports.conf data to find the mappings and return them.
     * The order is determined by.
     * @param {Number} clusterPort
     */
    _findClusterPortMappings(clusterPort)
    {
        /* Filter the list on cluster port */
        const mappings = this.clusterPortsMappings.filter( mapping => mapping.clusterPort === clusterPort );

        /* TODO: Set the order of the mappings according to some algorithm.
         * For example on maxConn/activeConn.
         * For now we just randomize the order to get an even distribution. */

        /* Randomize array in-place using Durstenfeld shuffle algorithm
         * https://stackoverflow.com/questions/2450954/how-to-randomize-shuffle-a-javascript-array */
        function shuffleArray(array) {
            for (var i = array.length - 1; i > 0; i--) {
                var j = Math.floor(Math.random() * (i + 1));
                var temp = array[i];
                array[i] = array[j];
                array[j] = temp;
            }
        }

        shuffleArray(mappings);

        return mappings;
    }

    /**
     * Open a connection to a local port.
     * This is the host port bound to the pod port.
     *
     * @param {number} port
     * @return Promise resolves to socket on success, null otherwise
     */
    async _openHostPort(port)
    {
        return new Promise( resolve => {
            const config = {
                host: this.config.PODHOST || this.config.HOST,
                port: port
            };
            try {
                logDebug(`Opening host port: ${port}`);
                const client = new TCPClient(config);
                client.onConnect( () => {
                    resolve(client);
                });
                client.onDisconnect( () => {
                    resolve(null);
                });
                client.connect();
            }
            catch(e) {
                logError(`Could not open connection to local host port ${config.host}:${config.port}`);
                resolve(null);
            }
        });
    }

    /**
     * Incoming connection on a cluster port, from a local pod.
     *
     * @param {AbstractClientSocket} clusterPortSocket
     * @param {number} clusterPort
     *
     */
    async _handleClusterPortConnection(clusterPortSocket, clusterPort)
    {
        logDebug(`Incoming cluster port connection on: ${clusterPort}`);
        const addresses = this._getHostAddresses(clusterPort);
        let index;
        for (index=0; index<addresses.length; index++) {
            const [proxyHost, proxyPort] = addresses[index];
            const [proxySocket, sendProxy, buffer] = await this._connectToProxy(proxyHost, proxyPort, clusterPort);
            if (proxySocket) {
                // OK
                this._pairToProxy(clusterPortSocket, proxySocket, sendProxy, clusterPort, buffer);
                return;
            }
        }
        logWarn(`Could not find match for cluster port ${clusterPort} on any host`);
        clusterPortSocket.disconnect();
    }

    /**
     * Return a list of hosts to try to connect to clusterport.
     *
     * @param {number | null} clusterPort the port can be taken into account when we have remembered
     *  state about success and failures find cluster ports on certain hosts.
     *  But for not it is ignored.
     *
     *  @return {HostAddress[]}
     */
    _getHostAddresses(clusterPort)
    {
        return this.hostList;
    }

    /**
     * Connect to proxy on host.
     * Send proxy protocol header including the requested cluster port.
     * Read back status.
     *
     * @return {Array<socket, sendProxy: boolean, buffer: Buffer> | []}
     */
    async _connectToProxy(proxyHost, proxyPort, clusterPort)
    {
        logDebug(`Connect to Proxy ${proxyHost}:${proxyPort} for cluster port ${clusterPort}...`);

        return new Promise( resolve => {
            try {
                const config = {
                    host: proxyHost,
                    port: proxyPort
                };

                const client = new TCPClient(config);

                let buffer = Buffer.alloc(0);
                const onData = data => {
                    buffer = Buffer.concat([buffer, data]);
                    const index = buffer.indexOf(Buffer.from("\r\n"));
                    if (index > -1) {
                        const str = buffer.slice(0, index).toString();
                        logDebug(`Proxy answered: ${str}`);
                        if (str === "BUSY") {
                            // TODO: remember the BUSY status
                            finish([]);
                            client.disconnect();
                        }
                        else {
                            let sendProxy = false;
                            if (str === "SENDPROXY=true") {
                                sendProxy = true;
                            }
                            finish([client, sendProxy, buffer.slice(index + 2)]);
                        }
                    }
                };

                const onDisconnect = () => {
                    finish([]);
                };

                const onConnect = () => {
                    /* Send proxy protocol header.
                     * Only interesting field here is the clusterPort
                     */
                    const header = `PROXY TCP4 1.2.3.4 1.2.3.4 123 ${clusterPort}\r\n`;
                    logDebug(`Send header to proxy: ${header.slice(0, -2)}`);
                    client.send(Buffer.from(header));
                };

                let isFinished = false;
                const finish = (ret) => {
                    if (isFinished) {
                        return;
                    }
                    isFinished = true;
                    client.offData(onData);
                    client.offConnect(onConnect);
                    client.offDisconnect(onDisconnect);
                    resolve(ret);
                };
                client.onData(onData);
                client.onConnect(onConnect);
                client.onDisconnect(onDisconnect);

                /* Set a general timeout */
                setTimeout( () => {
                    finish([]);
                }, 3000);

                client.connect();
            }
            catch(e) {
                console.error(e);
                logError(`Could not connect to Proxy`);
            }
        });
    }

    /**
     * Pair an incoming socket on a cluster port with a outgoing socket to other proxy.
     *
     * @param {Socket} clusterPortSocket incoming socket on reverse proxy (cluster port).
     * @param {Socket} proxySocket connected to other Proxy
     * @param {boolean} sendProxy set to true if target pod is expecting proxy protocol header
     * @param {number} clusterPort
     * @param {Buffer} buffer whatever data needed to be send on cluster port socket because it was read it earlier from proxy host port
     */
    _pairToProxy(clusterPortSocket, proxySocket, sendProxy, clusterPort, buffer)
    {
        logDebug(`Pair cluster port with proxy`);

        /* If the pod is expecting a proxy header, then we allow for a longer grace period before
         * deciding the client is not providing it. */
        const TIMEOUT_SENDPROXY = sendProxy ? 3000 : 1000;

        const INITIAL           = 1;
        const READY             = 3;
        const bufferedDataOut   = [buffer];
        const bufferedDataIn    = [];
        let stage               = INITIAL;

        proxySocket.onData( data => {
            clusterPortSocket.send(data);
        });

        proxySocket.onDisconnect( () => {
            logDebug(`Disconnected cluster port ${clusterPort} from proxy`);
            clusterPortSocket.disconnect();
        });

        clusterPortSocket.onDisconnect( () => {
            logDebug(`Disconnected from cluster port ${clusterPort}`);
            proxySocket.disconnect();
        });

        const sendProxyHeader = (header) => {
            /* Make a header up if sender did not provide.
             * https://www.haproxy.org/download/1.8/doc/proxy-protocol.txt
             */
            header = header || `PROXY TCP4 ${clusterPortSocket.getLocalAddress()} ${proxySocket.getRemoteAddress()} ${clusterPortSocket.getRemotePort()} ${clusterPortSocket.getLocalPort()}`;

            logDebug(`Send proxy header:`, header);
            proxySocket.send(Buffer.from(header + "\r\n"));
        };

        /**
         * Send any buffered data "accidentally" read from proxy to cluster port.
         */
        const flushBufferToClusterPort = () => {
            while (bufferedDataOut.length > 0) {
                const data = bufferedDataOut.shift();
                clusterPortSocket.send(data);
            }
        };

        /**
         * Send any buffered data read from cluster port to proxy
         */
        const flushBufferToProxy = () => {
            while (bufferedDataIn.length > 0) {
                const data = bufferedDataIn.shift();
                proxySocket.send(data);
            }
        };

        /* Using a timeout make sure a proxy protocol header is sent, even for protocols where
         * server speaks first, like SSH.
         * This timeout only does something if no data has been sent yet by client.
         */
        setTimeout( () => {
            if (stage === INITIAL) {
                logDebug("Timeout waiting for data on cluster port, assuming it will not send any header");
                /* Client might or might not have sent some data.
                 * In any case, not enough to understand if it is a header or not, so we assume it is not.
                 * Since the remote is expecting a proxy protocol header we craft and send one now. */
                if (sendProxy) {
                    sendProxyHeader();
                }
                stage = READY;
                flushBufferToClusterPort();
            }
        }, TIMEOUT_SENDPROXY);

        clusterPortSocket.onData( data => {
            bufferedDataIn.push(data);

            if (stage === INITIAL) {
                const header = this._parseHeader(bufferedDataIn);
                if (header === null) {
                    /* Not enough data to parse, wait for more */
                    return;
                }
                else if (header === "") {
                    /* No header provided, check if to inject one */
                    if (sendProxy) {
                        sendProxyHeader();
                    }
                }
                else {
                    /* Header provided, check if to send it or strip it out */
                    if (sendProxy) {
                        sendProxyHeader(header);
                    }
                    else {
                        logDebug("Strip header");
                    }
                }

                logDebug("Cluster port successfully paired with proxy");
                stage = READY;
                flushBufferToClusterPort();
                /* Fall through to next stage */
            }

            if (stage === READY) {
                flushBufferToProxy();
            }
        });
    }

    /**
     * From array of buffers parse out the PROXY PROTOCOL header, if existing.
     *
     * @param {Buffer[]} buffers
     *  This array is modified in place, all buffers in the array are concated to a single element
     *  If the header is found it is extracted from the buffer
     *
     * @return {string | null}
     *  empty string if data does not contain header
     *  null if more data is needed
     *  string of PROXY PROTOCOL header if found
     */
    _parseHeader(buffers)
    {
        /* Since there cannot be too much data already we take the easy route of collapsing all data into
         * a single buffer so it is easier to work with. */
        const buffer = Buffer.concat(buffers);
        buffers[0] = buffer;
        buffers.length = 1;

        const prefix    = "PROXY TCP4 ";  //255.255.255.255 65535 255.255.255.255 65535\r\n";
        const l         = Math.min(buffer.length, prefix.length);
        const s         = buffer.slice(0, l).toString();

        if (!prefix.startsWith(s)) {
            /* Can never be a proxy protocol header */
            return "";
        }

        const index = buffer.indexOf(Buffer.from("\r\n"));

        if (index === -1 && buffer.length >= 56) {
            /* This can never be a proxy protocol header */
            return "";
        }

        if (index === -1) {
            /* We need more data */
            return null;
        }

        const header = buffer.slice(0, index).toString();
        buffers[0] = buffer.slice(index + 2);
        return header;
    }
}

module.exports = Proxy;
