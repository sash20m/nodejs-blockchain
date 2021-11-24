const crypto = require("crypto"),
    Swarm = require("discovery-swarm"),
    defaults = require("dat-swarm-defaults"),
    getPort = require("get-port"),
    chain = require("./chain"),
    CronJob = require("cron").CronJob,
    express = require("express"),
    bodyParser = require("body-parser"),
    wallet = require("./wallet");

const peers = {};
let connSeq = 0;
let channel = "myBlockchain",
    registeredMiners = [],
    lastBlockMinedBy = null;

let MessageType = {
    REQUEST_BLOCK: "requestBlock",
    RECEIVE_NEXT_BLOCK: "receiveNextBlock",
    RECEIVE_NEW_BLOCK: "receiveNewBlock",
    REQUEST_ALL_REGISTER_MINERS: "requestAllRegisterMiners",
    REGISTER_MINER: "registerMiner",
};

const myPeerId = crypto.randomBytes(32);
console.log("myPeerId: " + myPeerId.toString("hex"));

chain.createDb(myPeerId.toString("hex"));

let initHttpServer = (port) => {
    let http_port = "80" + port.toString().slice(-2);
    let app = express();
    app.use(bodyParser.json());
    app.get("/blocks", (req, res) =>
        res.send(JSON.stringify(chain.blockchain))
    );
    app.get("/getBlock", (req, res) => {
        let blockIndex = req.query.index;
        res.send(chain.blockchain[blockIndex]);
    });
    app.get("/getDBBlock", (req, res) => {
        let blockIndex = req.query.index;
        chain.getDbBlock(blockIndex, res);
    });
    app.get("/getWallet", (req, res) => {
        res.send(wallet.initWallet());
    });
    app.listen(http_port, () =>
        console.log("Listening http on port: " + http_port)
    );
};

const config = defaults({
    id: myPeerId,
});

const swarm = Swarm(config);

(async () => {
    const port = await getPort();

    initHttpServer(port);
    swarm.listen(port);
    console.log("Listening port: " + port);

    swarm.join(channel);
    swarm.on("connection", (conn, info) => {
        const seq = connSeq;
        const peerId = info.id.toString("hex");
        console.log(`Connected #${seq} to peer: ${peerId}`);
        if (info.initiator) {
            try {
                conn.setKeepAlive(true, 3000);
            } catch (exception) {
                console.log("exception", exception);
            }
        }

        conn.on("data", (data) => {
            let message = JSON.parse(data);
            console.log(" ");
            console.log("----------- Received Message start -------------");
            console.log(
                "from: " + peerId.toString("hex"),
                "to: " + peerId.toString(message.to),
                "my: " + myPeerId.toString("hex"),
                "type: " + JSON.stringify(message.type)
            );
            console.log("----------- Received Message end -------------");
            console.log(" ");

            switch (message.type) {
                case MessageType.REQUEST_BLOCK:
                    console.log(" ");
                    console.log("-----------REQUEST_BLOCK-------------");
                    let requestedIndex = JSON.parse(
                        JSON.stringify(message.data)
                    ).index;
                    let requestedBlock = chain.getBlock(requestedIndex);
                    if (requestedBlock)
                        writeMessageToPeerToId(
                            peerId.toString("hex"),
                            MessageType.RECEIVE_NEXT_BLOCK,
                            requestedBlock
                        );
                    else
                        console.log(
                            "No block found @ index: " + requestedIndex
                        );
                    console.log("-----------REQUEST_BLOCK-------------");
                    console.log(" ");
                    break;
                case MessageType.RECEIVE_NEXT_BLOCK:
                    console.log(" ");
                    console.log("-----------RECEIVE_NEXT_BLOCK-------------");
                    chain.addBlock(JSON.parse(JSON.stringify(message.data)));
                    console.log(JSON.stringify(chain.blockchain));
                    let nextBlockIndex = chain.getLatestBlock().index + 1;
                    console.log(
                        "\n-- request next block @ index: " + nextBlockIndex,
                        "\n"
                    );
                    writeMessageToPeers(MessageType.REQUEST_BLOCK, {
                        index: nextBlockIndex,
                    });
                    console.log("-----------RECEIVE_NEXT_BLOCK-------------");
                    console.log(" ");
                    break;
                case MessageType.RECEIVE_NEW_BLOCK:
                    if (
                        message.to === myPeerId.toString("hex") &&
                        message.from !== myPeerId.toString("hex")
                    ) {
                        console.log(" ");
                        console.log(
                            "-----------RECEIVE_NEW_BLOCK------------- " +
                                message.to
                        );
                        chain.addBlock(
                            JSON.parse(JSON.stringify(message.data))
                        );
                        console.log(JSON.stringify(chain.blockchain));
                        console.log(
                            "-----------RECEIVE_NEW_BLOCK------------- " +
                                message.to
                        );
                        console.log(" ");
                    }
                    break;
                case MessageType.REQUEST_ALL_REGISTER_MINERS:
                    console.log(" ");
                    console.log(
                        "-----------REQUEST_ALL_REGISTER_MINERS------------- " +
                            message.to
                    );
                    writeMessageToPeers(
                        MessageType.REGISTER_MINER,
                        registeredMiners
                    );
                    registeredMiners = JSON.parse(JSON.stringify(message.data));
                    console.log(
                        "-----------REQUEST_ALL_REGISTER_MINERS------------- " +
                            message.to
                    );
                    console.log(" ");
                    break;
                case MessageType.REGISTER_MINER:
                    console.log(" ");
                    console.log("-----------REGISTER_MINER------------- ");
                    console.log(message.data, " ah?");
                    let miners = JSON.stringify(message.data);
                    registeredMiners = JSON.parse(miners);
                    console.log(registeredMiners);
                    console.log("-----------REGISTER_MINER------------- ");
                    console.log(" ");
                    break;
            }
        });

        conn.on("close", () => {
            console.log(`Connection ${seq} closed, peerId: ${peerId}`);
            if (peers[peerId].seq === seq) {
                delete peers[peerId];
                console.log(" ");
                console.log(
                    "--- registeredMiners before: " +
                        JSON.stringify(registeredMiners)
                );
                let index = registeredMiners.indexOf(peerId);
                if (index > -1) registeredMiners.splice(index, 1);
                console.log(
                    "--- registeredMiners end: " +
                        JSON.stringify(registeredMiners)
                );
                console.log(" ");
            }
        });

        if (!peers[peerId]) {
            peers[peerId] = {};
        }
        peers[peerId].conn = conn;
        peers[peerId].seq = seq;
        connSeq++;
    });
})();

writeMessageToPeers = (type, data) => {
    for (let id in peers) {
        console.log(" ");
        console.log("-------- writeMessageToPeers start -------- ");
        console.log("type: " + type + ", to: " + id);
        console.log("-------- writeMessageToPeers end ----------- ");
        console.log(" ");
        sendMessage(id, type, data);
    }
};

writeMessageToPeerToId = (toId, type, data) => {
    for (let id in peers) {
        if (id === toId) {
            console.log(" ");
            console.log("-------- writeMessageToPeerToId start -------- ");
            console.log("type: " + type + ", to: " + toId);
            console.log("-------- writeMessageToPeerToId end ----------- ");
            console.log(" ");
            sendMessage(id, type, data);
        }
    }
};

sendMessage = (id, type, data) => {
    peers[id].conn.write(
        JSON.stringify({
            to: id,
            from: myPeerId,
            type: type,
            data: data,
        })
    );
};

setTimeout(function () {
    writeMessageToPeers(MessageType.REQUEST_ALL_REGISTER_MINERS, null);
}, 6000);

setTimeout(function () {
    writeMessageToPeers(MessageType.REQUEST_BLOCK, {
        index: chain.getLatestBlock().index + 1,
    });
}, 5000);

setTimeout(function () {
    console.log(myPeerId.toString("hex"), " ", registeredMiners);
    registeredMiners.push(myPeerId.toString("hex"));
    console.log(" ");
    console.log("---------- Register myself as miner --------------");
    console.log(registeredMiners);
    writeMessageToPeers(MessageType.REGISTER_MINER, registeredMiners);
    console.log("---------- Register myself as miner --------------");
    console.log(" ");
}, 8000);

const job = new CronJob("30 * * * * *", function () {
    let index = 0; // first block
    if (lastBlockMinedBy) {
        let newIndex = registeredMiners.indexOf(lastBlockMinedBy);
        index = newIndex + 1 > registeredMiners.length - 1 ? 0 : newIndex + 1;
    }
    lastBlockMinedBy = registeredMiners[index];

    console.log("miners - ", JSON.stringify(registeredMiners));
    if (registeredMiners[index] === myPeerId.toString("hex")) {
        console.log(" ");
        console.log("-----------create next block -----------------");
        let newBlock = chain.generateNextBlock(null);
        chain.addBlock(newBlock);
        console.log("new block", JSON.stringify(newBlock));
        writeMessageToPeers(MessageType.RECEIVE_NEW_BLOCK, newBlock);
        // console.log(JSON.stringify(chain.blockchain));
        console.log("-----------create next block -----------------");
        console.log(" ");
    } else {
        console.log(" ");
        console.log(
            "-- REQUESTING NEW BLOCK FROM: " +
                registeredMiners[index] +
                ", index: " +
                index
        );
        console.log(" ");
    }
});
job.start();
