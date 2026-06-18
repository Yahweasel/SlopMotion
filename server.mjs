/// SPDX-License-Identifier: ISC
/**
 * Copyright (c) 2026 Yahweasel
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED “AS IS” AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 * LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
 * OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 * PERFORMANCE OF THIS SOFTWARE.
 */

import * as fs from "fs/promises";
import * as http from "http";

import * as ws from "ws";

import * as twitchAuth from "@twurple/auth";
import * as twitchBot from "@twurple/easy-bot";

import * as obscenity from "obscenity";

import serveStatic from "serve-static";
import finalhandler from "finalhandler";

const PORT = 17591;
const ID_LEN = 5;

const SOCK_PATH = "/ws";
const PROXY_PATH = "/v1/chat/completions";
const SAVE_PATH = "/save";
const GAMES_PATH = "/games";

const config = JSON.parse(await fs.readFile("config.json", "utf8"));

// Prepare for user-generated nonsense
const obsMatcher = new obscenity.RegExpMatcher({
    ...obscenity.englishDataset.build(),
    ...obscenity.englishRecommendedTransformers
});
const obsCensor = new obscenity.TextCensor();


// Serve current directory
const serve = serveStatic(process.cwd());

let saveIndex = 0;
const games = await (async () => {
    try {
        return JSON.parse(await fs.readFile("programs/games.json", "utf8"));
    } catch (ex) {}
    return [];
})();

// Add other URLs in the full server
const server = http.createServer();
const wss = new ws.WebSocketServer({ server });

// The current client's WebSocket, which starts unfilled
let sock = null;

server.on("request", async (req, res) => {
    if (req.url.startsWith(SOCK_PATH)) {
        // Wait for upgrade
        return;

    } else if (req.url.startsWith(PROXY_PATH)) {
        const targetUrl = new URL(req.url, config.openai.host);

        const proxyReq = http.request(targetUrl, {
            method: req.method,
            headers: req.headers,
        }, proxyRes => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        });

        req.pipe(proxyReq); // stream request body
        proxyReq.on("error", () => {
            res.writeHead(502);
            res.end("Bad Gateway");
        });

    } else if (req.url.startsWith(SAVE_PATH)) {
        await fs.mkdir("programs", {recursive: true});
        for (;; saveIndex++) {
            try {
                await fs.access(`programs/${saveIndex}.txt`);
            } catch (ex) {
                break;
            }
        }
        const fh = await fs.open(`programs/${saveIndex++}.txt`, "w");
        const ws = fh.createWriteStream();
        let code = "";
        for await (const chunk of req) {
            code += chunk.toString("utf8");
            ws.write(chunk);
        }
        ws.end();

        // Look for the description
        {
            const re = /DESCRIPTION:\s*(.*)/g;
            let parts;
            while (true) {
                const next = re.exec(code);
                if (next) parts = next;
                else break;
            }
            if (parts) {
                games.push(parts[1]);
                await fs.writeFile("programs/games.json.tmp", JSON.stringify(games));
                await fs.rename("programs/games.json.tmp", "programs/games.json");
            }
        }

        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(JSON.stringify({index: saveIndex-1}));

    } else if (req.url.startsWith(GAMES_PATH)) {
        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(JSON.stringify(games));

    } else {
        serve(req, res, finalhandler(req, res)); // serve local files

    }
});


// Functionality for buffering messages to send
let toSend = "";

async function send(msg) {
    toSend += msg;

    if (sock) {
        try {
            sock.send(toSend);
        } catch (ex) {
            console.error("Send:", ex);
        }

        toSend = "";
    }
}

let recvd = "";

async function recv(msg) {
    recvd += msg;

    const lines = recvd.split("\n");

    while (lines.length > 1) {
        msg = lines.shift();
        msg = JSON.parse(msg);

        switch (msg.c) {
            case "save":
            {
                let id = "", file = "";
                while (true) {
                    id = (~~(Math.random() * Math.pow(36, ID_LEN)))
                        .toString(36).padStart(ID_LEN, "0");
                    if (obsMatcher.hasMatch(id))
                        continue;
                    file = `programs/${id}.json`;
                    try {
                        await fs.access(file);
                    } catch (ex) {
                        break;
                    }
                }
                try {
                    await fs.writeFile(file, JSON.stringify(msg.d));
                } catch (ex) {
                    console.error(ex);
                }
                send(JSON.stringify({c: "save", id}) + "\n");
                break;
            }

            case "good":
            {
                const file = `programs/${msg.id}.json`;
                try {
                    const data = JSON.parse(await fs.readFile(
                        file, "utf8"
                    ));
                    data.good = true;
                    await fs.writeFile(file, JSON.stringify(data));
                } catch (ex) {
                    console.error(ex);
                }
                break;
            }

            case "list":
            {
                const files = await fs.readdir("programs");
                const list = [];
                while (list.length < 128 && files.length) {
                    const idx = ~~(Math.random() * files.length);
                    const file = files[idx];
                    files.splice(idx, 1);
                    try {
                        const data = JSON.parse(
                            await fs.readFile(`programs/${file}`, "utf8")
                        );
                        if (!data.good)
                            continue;
                        delete data.input;
                        delete data.reasoning;
                        data.id = file.slice(0, ID_LEN);
                        list.push(data);
                    } catch (ex) {}
                }
                send(JSON.stringify({
                    c: "list",
                    d: list
                }) + "\n");
                break;
            }

            case "random":
            {
                const files = await fs.readdir("programs");
                let ret = null;
                while (files.length) {
                    const idx = ~~(Math.random() * files.length);
                    const file = files[idx];
                    files.splice(idx, 1);
                    try {
                        const data = JSON.parse(
                            await fs.readFile(`programs/${file}`, "utf8")
                        );
                        if (!data.good)
                            continue;
                        data.id = file.slice(0, ID_LEN);
                        ret = data;
                        break;
                    } catch (ex) {}
                }
                send(JSON.stringify({
                    c: "random",
                    d: ret
                }) + "\n");
                break;
            }
        }
    }

    recvd = lines[0];
}

wss.on("connection", async csock => {
    sock = csock;

    csock.on("message", msg => {
        recv(msg);
    });

    if (toSend)
        send("");
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));


// Now handle Twitch
{
    const bot = new twitchBot.Bot({
        authProvider: new twitchAuth.StaticAuthProvider(
            config.twitch.client_id,
            config.twitch.access_token
        ),

        channels: [config.twitch.channel],

        commands: [
            twitchBot.createBotCommand("ai", onai),
            twitchBot.createBotCommand("AI", onai),
            twitchBot.createBotCommand("Ai", onai),
            twitchBot.createBotCommand("load", onload)
        ]
    });

    function onai(params, { userName }) {
        let prompt = params.join(" ");
        const obs = obsMatcher.getAllMatches(prompt);
        prompt = obsCensor.applyTo(prompt, obs);
        send(JSON.stringify({
            c: "prompt",
            prompt: {
                user: userName,
                prompt
            }
        }) + "\n");
    }

    async function onload(params, { userName }) {
        const id = params[0];
        if (!/^[a-z0-9]{5}$/.test(id))
            return;
        try {
            const program = JSON.parse(await fs.readFile(`programs/${id}.json`, "utf8"));
            program.id = id;
            send(JSON.stringify({
                c: "prompt",
                prompt: {
                    user: userName,
                    program
                }
            }) + "\n");
        } catch (ex) {}
    }
}
