#!/usr/bin/env node

const Proxy = require("../proxy");
const assert = require("assert");

const proxy = new Proxy();

const buffers = [];
let a = proxy._parseHeader(buffers);
assert(a === null);
buffers.push(Buffer.from("PR"));
a = proxy._parseHeader(buffers);
assert(a === null);
buffers.push(Buffer.from("o"));
a = proxy._parseHeader(buffers);
assert(a === "");
buffers.pop();
buffers.push(Buffer.from("PRO"), Buffer.from("XY TCP\r\n"));
a = proxy._parseHeader(buffers);
assert(a === "");
buffers.pop();
buffers.push(Buffer.from("PRO"), Buffer.from("XY TCP4 1.1.1.1 1.1.1.1 10 20\r\n"));
a = proxy._parseHeader(buffers);
assert(a.length > 0);

setTimeout( () => {
    proxy.shutdown();
    console.error("Done");
}, 1000);
