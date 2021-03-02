# Simplenetes Proxy

The proxy's job is to proxy internal traffic within the cluster.

In the spirit of Simplenetes the proxy is robust and simple.

The proxy runs on each _host_ in the cluster.

It listens to a range of _cluster ports_. A cluster port is a cluster wide port number which is associated with one or many pods.
The point is that if pod A wants to talk to an instance of pod B, and pod B is associated with the cluster port 1024, then pod A will simply open a connection to the proxy running on the same host as it self to the port 1024. The Proxy will then tunnel this connection to another (or the same) host in the cluster to connect with pod B.

When routing the Proxy tries all hosts until it finds some host which is running pod B.

Many pods can listen to the same cluster port, traffic is balanced over hosts and also within hosts.

## Proxy Protocol header (sendProxy)

A Pod can require that incoming traffic always provides `proxy protocol header`, this is configured in the `pod.yaml` file.
Th Proxy will always add such a header if it is not present and the receiving pod requires it, and vice versa, it will remove any such header if the pod does not want it.

## File formats

_proxy.conf_:  
```conf
# Path to hosts file, listing all hosts in the cluster and the port the proxy is listening on.
# Auto generated by the `snt` tool.
HOSTSCONF hosts.conf

# Path to port mappings file. The port mappings file is auto generated by the Simplenetes Daemon.
PORTSCONF portmappings.conf

# Where to bind the proxy port
HOST localhost

# Port to listen to for proxy traffic
PORT 32767,

# Optional override over HOST for using when connecting to pods host ports.
PODHOST ""

# Cluster ports to listen to.
# These ranges can be limited.
# If only using auto assigned cluster ports it is enough to bind the range `61000-63999`.
CLUSTERPORTS 1024-29999,32768-65535
```

_portmappings.conf_:  
Each item has four fields as: `clusterPort:hastPort:maxConn:sendProxy`.  
There can be many items on each row, or just one per row.  
```conf
1024:3000:100:false
```

This file is autogenerated by the Simplenetes Daemon and its contents depend on what pods are running and which are available.

_hosts.conf_:  
One item per line, tuple of `IP/host:port`.  
```conf
IP:port
IP:port
IP:port
```

The file is autogenerated by the Simplenetes `snt` tool.


## Run

```sh
yarn install

./run.js [path-to-proxy.conf]
```

## Build
The node.js application can be built into a native executable.  
```sh
yarn install

./build.sh [target(s)]
```

To see different targets run `./node_modules/.bin/pkg -h`.

The output is based in the directory `./build`.