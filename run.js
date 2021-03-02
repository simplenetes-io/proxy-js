#!/usr/bin/env node

const Proxy = require("./proxy");

const proxy = new Proxy(process.argv[2]);
