# Subchain

A subchain is a blockchain driven by commands received from a rootchain.

## What is this?

This is a fun project that demonstrates how [stateless smart contracts](https://medium.com/@childsmaidment/stateless-smart-contracts-21830b0cd1b6) can be used to drive subchains.

## How does it work?

Instead of storing contract state on a rootchain you store a set of commands in the inputs of rootchain transactions. Commands can include smart contract deployments or other transactions that can be passed down to a subchain for execution.

## Installation

Requirements: Node v8.11.2

1.  `npm install`
2.  `npm run build`

## Usage

You can sync an example ropsten subchain with the following:

`node dist/cli.js -r https://ropsten.infura.io/ -m 0xc9ec7da86f0bde73345ba04df4613b0b70612a54`
