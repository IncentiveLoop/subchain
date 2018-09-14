#!/usr/bin/env node

import "babel-polyfill";
import fs from "fs";
import yargs from "yargs";
import Web3 from "web3";
import Ganache from "ganache-core";
import { BlockAndLogStreamer } from "ethereumjs-blockstream";
import path from "path";
import cliProgress from "cli-progress";

import messengerABI from "./abis/messenger";
import managerABI from "./abis/manager";
import managerData from "./precompile/manager";

const argv = yargs
  .strict()
  .option("r", {
    alias: "rootchain",
    type: "string",
    describe: "Rootchain RPC endpoint"
  })
  .option("m", {
    alias: "messenger",
    type: "string",
    describe: "The address of the Messenger contract on the rootchain"
  })
  .option("db", {
    alias: "dbPath",
    type: "string",
    default: path.resolve(__dirname, "db"),
    describe: "The database path"
  })
  .option("p", {
    alias: "port",
    type: "number",
    default: 8545,
    describe: "Subchain RPC port"
  })
  .demandOption(["r", "m"]).argv;

const run = async () => {
  const rootchain = new Web3(argv.rootchain);

  // set up the messenger contract
  const messenger = new rootchain.eth.Contract(messengerABI, argv.messenger);
  const messengerBlockNumber = await messenger.methods.created().call();
  const messengerBlock = await rootchain.eth.getBlock(messengerBlockNumber);
  const messengerTimestamp = messengerBlock.timestamp;

  // create db path if it does't exist
  if (!fs.existsSync(argv.db)) {
    fs.mkdirSync(argv.db);
  }

  const server = Ganache.server({
    mnemonic:
      "truth woman royal raccoon gossip force again crisp friend harsh praise imitate",
    allowUnlimitedContractSize: true,
    vmErrorsOnRPCResponse: false,
    gasPrice: "0", // no gas price
    gasLimit: "0x5f5e100", // 100 million gas limit
    db_path: argv.db,
    time: new Date(messengerTimestamp * 1000),
    ws: false,
    logger: {
      log: method => {
        // disallow some methods over http
        switch (method) {
          case "eth_sendTransaction":
          case "eth_sendRawTransaction":
          case "eth_sign":
          case "miner_start":
          case "miner_stop":
          case "personal_importRawKey":
          case "personal_unlockAccount":
          case "personal_sendTransaction":
            throw new Error(`The ${method} method is not allowed.`);
          default:
            break;
        }
      }
    }
  });

  server.listen(argv.port, async (err, blockchain) => {
    console.log("subchain running");

    const subchain = new Web3(blockchain._provider);

    const maxGas = 99000000;
    const genesisAddress = "0x0000000000000000000000000000000000000000";
    const zeroHash =
      "0x0000000000000000000000000000000000000000000000000000000000000000";
    const rejected = subchain.utils.sha3("rejected");

    // extend Web3 methods
    subchain.extend({
      methods: [
        {
          name: "stopMining",
          call: "miner_stop"
        },
        {
          name: "mine",
          call: "evm_mine",
          params: 1
        },
        {
          name: "snapshot",
          call: "evm_snapshot"
        },
        {
          name: "revert",
          call: "evm_revert",
          params: 1
        }
      ]
    });

    // stop auto-mining
    await subchain.stopMining();

    // whitelisting allows the subchain to fake transactions on behalf of an address
    const whitelist = address => {
      blockchain._provider.manager.state.unlocked_accounts[
        // lowercase address to match Ganache address validation
        // https://github.com/trufflesuite/ganache-core/blob/1cc5eb3f8b717685d0c6f5bdeba1015b962cc7d3/lib/statemanager.js#L304
        address.toLowerCase()
      ] = true;
    };

    const [controller] = await subchain.eth.getAccounts();

    const sendTransaction = ({ from, to, data }) =>
      new Promise((resolve, reject) => {
        subchain.eth
          .sendTransaction({
            from,
            to,
            data,
            gas: maxGas
          })
          .on("transactionHash", hash => resolve(hash))
          .on("error", error => console.log(error.message));
      });

    const createManagerContract = async () => {
      const expectedAddress = "0xb7208c5505bf59d7c656e715e3b0a5d9bf364035";
      if ((await subchain.eth.getCode(expectedAddress)) === "0x0") {
        const txHash = await sendTransaction({
          from: controller,
          data: managerData
        });
        await subchain.mine(messengerTimestamp);
      }
      return new subchain.eth.Contract(managerABI, expectedAddress, {
        from: controller
      });
    };

    const manager = await createManagerContract();

    // determine what block we should start syncing from
    let fromBlock;
    // get the last transaction processed on the subchain
    const lastTx = await manager.methods.lastTx().call();
    if (lastTx === zeroHash) {
      // start syncing from the creation of the messenger contract
      fromBlock = messengerBlockNumber;
    } else {
      // start syncing from the last confirmed transaction
      const transaction = await rootchain.eth.getTransaction(lastTx);
      fromBlock = transaction.blockNumber;
    }

    // get blocks up to current block - 10;
    // https://github.com/ethereumjs/ethereumjs-blockstream/issues/22#issuecomment-410431559
    const currentBlock = await rootchain.eth.getBlockNumber();
    const toBlock = currentBlock - 10;

    const events = await messenger.getPastEvents("allEvents", {
      fromBlock,
      toBlock
    });

    // rootchain txHash => snapshot
    const snapshots = {};

    const snapshot = async txHash => {
      snapshots[txHash] = await subchain.snapshot();
    };

    const setConfirmed = (rootTxHash, subTXHash) =>
      new Promise(resolve => {
        manager.methods
          .setConfirmed(rootTxHash, subTXHash)
          .send()
          .on("transactionHash", () => resolve());
      });

    const processTransaction = async ({ hash, to, data, from, timestamp }) => {
      try {
        // snapshot state
        await snapshot(hash);

        if (to && (await subchain.eth.getCode(to)) === "0x0") {
          // transactions with data sent to addresses that are not contracts will break things
          // this will be fixed with https://github.com/trufflesuite/ganache-core/pull/159
          await setConfirmed(hash, rejected);
        } else {
          const txHash = await sendTransaction({ from, to, data });
          await setConfirmed(hash, txHash);
        }

        // mine transactions
        await subchain.mine(timestamp);
      } catch (e) {
        console.log(e.message);
      }
    };

    const processLog = async log => {
      const confirmed = await manager.methods
        .confirmed(log.transactionHash)
        .call();

      // skip if we have already confirmed
      if (confirmed !== zeroHash) {
        return;
      }

      // get the transaction and block
      const [transaction, block] = await Promise.all([
        await rootchain.eth.getTransaction(log.transactionHash),
        await rootchain.eth.getBlock(log.blockNumber)
      ]);

      // whitelist the address
      whitelist(transaction.from);

      // recover input
      const input = transaction.input.slice(10);
      const decoded = rootchain.eth.abi.decodeParameters(
        [
          {
            type: "address",
            name: "to"
          },
          {
            type: "bytes",
            name: "data"
          }
        ],
        input
      );

      // transactions to genesis address are contract creations
      const to = decoded.to === genesisAddress ? null : decoded.to;

      return {
        hash: transaction.hash,
        to,
        data: decoded.data,
        from: transaction.from,
        timestamp: block.timestamp
      };
    };

    if (events.length) {
      console.log("syncing...");

      // setup loading bar
      const bar = new cliProgress.Bar({}, cliProgress.Presets.shades_classic);
      bar.start(events.length, 0);

      // batch transactions in groups of 10
      const batch = 10;
      for (let i = 0; i < events.length; i += batch) {
        const logs = events.slice(i, i + batch);
        // fetch transaction data in parallel
        const transactions = await Promise.all(logs.map(processLog));
        // process transactions in order
        for (let a = 0; a < transactions.length; a++) {
          await processTransaction(transactions[a]);
        }
        // update loading bar
        const inc = i + batch >= events.length ? events.length : i + batch;
        bar.update(inc);
      }
      bar.stop();
      console.log("sync complete");
    }

    // once initial syncing is done we start the block streamer
    const blockAndLogStreamer = new BlockAndLogStreamer(
      rootchain.eth.getBlock,
      async filter => {
        // getPastLogs needs hex encodings for fromBlock and toBlock
        return await rootchain.eth.getPastLogs({
          fromBlock: rootchain.utils.toHex(filter.fromBlock),
          toBlock: rootchain.utils.toHex(filter.toBlock),
          address: filter.address,
          topics: filter.topics
        });
      },
      err => console.log(err.message),
      { blockRetention: 100 }
    );

    blockAndLogStreamer.subscribeToOnLogAdded(async result => {
      // process new logs
      const log = await result;
      console.log(`New transaction ${log.transactionHash}`);
      await processTransaction(await processLog(log));
    });

    blockAndLogStreamer.subscribeToOnLogRemoved(async result => {
      const log = await result;

      // revert to the state before this transaction
      await subchain.revert(snapshots[log.transactionHash]);
    });

    // add filter for logs
    blockAndLogStreamer.addLogFilter({ address: argv.messenger, topics: [] });

    // add the first block to the reconciler
    blockAndLogStreamer.reconcileNewBlock(
      await rootchain.eth.getBlock(toBlock)
    );

    const poll = async (fn, ms) => {
      await fn();
      setTimeout(() => poll(fn, ms), ms);
    };

    poll(async () => {
      try {
        await blockAndLogStreamer.reconcileNewBlock(
          await rootchain.eth.getBlock("latest")
        );
      } catch (e) {
        console.log(e.message);
      }
    }, 5000);
  });
};

run();
