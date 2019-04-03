const {spawn} = require("child_process");
const crypto = require("crypto");
const AWS = require("aws-sdk");
const fs = require("fs");
const path = require("path");
const tar = require("tar-fs");
const config = require("./config");
const _ = require("lodash");
const axios = require("axios");
const docClient = new AWS.DynamoDB.DocumentClient({"region": "us-west-2"});
const stream = require("./streamAndSave");
let setupComplete = false;

// Used to determine if the lambda is hot or cold
const encrypted = process.env.GIT_SECRET;
let decrypted;
let token;
let iotGateway;

const postToDiffEnv = (url, body, xhubsig) => {
    return new Promise((fulfill, reject) => {
        axios.post(url, body,
            {
                headers: {
                    "X-Hub-Signature": xhubsig,
                    "Content-type": "application/json"
                }
            }).then((result) => {
            fulfill(result);
        }).catch((err) => {
            reject(err);
        })
    })
};

const checkGitSecret = async (event, context) => {
    let hash;
    let hmac;
    const signature = event.headers["X-Hub-Signature"];
    const calculatedSignature = `sha1=${crypto.createHmac("sha1", decrypted).update(event.body, "utf-8").digest("hex")}`;
    if (signature === calculatedSignature) {
        const parsed = JSON.parse(event.body);
        let branch = parsed.ref.split("/")[2];
        if (branch === "master") {
            branch = "prod";
        }
        console.log(`Received a message from branch ${branch}`);
        if (branch === process.env.AWS_ENV) {
            console.log("We are in the right branch... Triggering the SNS message.");
            // We are in the right environment, trigger the deployment...
            const repo = parsed.repository.full_name.split("/")[1];
            const details = {
                repo: repo,
                branch: branch,
                commitHash: parsed.after,
                commitMessage: parsed.head_commit.message,
                commiter: {
                    name: parsed.head_commit.committer.name,
                    email: parsed.head_commit.committer.email
                },
                clone_url: parsed.repository.clone_url
            };
            const currTime = (new Date).getTime();
            const msg = {
                git: details,
                buildTime: currTime
            };
            const params = {
                Message: JSON.stringify(msg),
                TargetArn: `arn:aws:sns:us-west-2:${process.env.AWS_ACCOUNT_NUMBER}:${process.env.AWS_ENV}-clone`
            };
            const p = {
                TableName: "build_lock",
                KeyConditionExpression: "repo_name = :repo_name",
                ExpressionAttributeValues: {
                    ":repo_name": repo
                }
            };
            let lock = {};
            try {
                const lockCheck = await docClient.query(p).promise();
                let newRepo = false;
                if (lock.Count > 0) {
                    lock = lockCheck.Items[0];
                    if (lock.end_time === undefined && lock.start_time > (currTime - (5 * 60 * 1000))) {
                        // There is no end time on the lock and the start time was < 5 minutes ago... Assume another build is going on...
                        console.log("Currently doing a build... Wait!");
                        return {
                            statusCode: 409,
                            body: JSON.stringify({msg: "Currently doing a build."})
                        };
                    } else {
                        // There has been a build before, so let us do an update...
                        console.log("Modifying an existing build...");
                        delete lock["end_time"];
                    }
                } else {
                    // Never built this repo before...
                    console.log("New build!");
                    lock.repo_name = repo;
                    newRepo = true;
                }
                lock.start_time = (new Date).getTime();
                lock.committer = {
                    name: parsed.head_commit.committer.name,
                    email: parsed.head_commit.committer.email
                };
                lock.message = parsed.head_commit.message;
                lock.hash = parsed.after;
                lock.error = false;
                const lockItem = {
                    TableName: "build_lock",
                    Item: lock
                };
                let type = "update";
                if (newRepo) {
                    type = "new";
                }
                console.log("calling stream and save");
                await stream.stream(lockItem, "repos", {type: type, payload: lock}, iotGateway);
                const sns = new AWS.SNS();
                await sns.publish(params).promise();
                console.log("Sent message to trigger build");
                return {"statusCode": 200};
            } catch (e) {
                console.log("Error:");
                console.log(e);
                return {"statusCode": 500};
            }
        } else {
            const url = _.find(config, (c) => {
                return c.env == branch;
            });
            if (url !== undefined) {
                // Not the right environment, so let's send it to the right place and call it a day...
                console.log("Found details where to send this message...");
                console.log(url);
                try {
                    await postToDiffEnv(url, event.body, event.headers["X-Hub-Signature"]);
                    return {"statusCode": 200};
                } catch (e) {
                    console.log("Error:");
                    console.log(e);
                    return {"statusCode": 500};
                }
            } else {
                console.log(`${branch} must be a feature branch. Do nothing...`);
                return {"statusCode": 200};
            }
        }
    } else {
        console.log("INTRUDER ALERT!");
        return {"statusCode": 401};
    }
};

module.exports.authenticate = async (event, context) => {
    if (decrypted) {
        //The lambda is warm and decrypted has the secret value in plain text in memory
        //Don't be stupid and expose it in a log!
        return checkGitSecret(event, context);
    } else {
        //Lambda is cold, need to decrypt the environmental variable and keep the plain text value in memory...
        const kms = new AWS.KMS({region: "us-west-2"});
        try {
            const decryptValue = await kms.decrypt({CiphertextBlob: Buffer(encrypted, "base64")}).promise();
            decrypted = decryptValue.Plaintext.toString("ascii");
            if (!iotGateway) {
                await getIotGateway();
                return checkGitSecret(event, context);
            } else {
                return checkGitSecret(event, context);
            }
        } catch (e) {
            console.log("Error:");
            console.log(e);
            return {"statusCode": 500};
        }
    }
};

const setUpGit = async () => {
    require("lambda-git")().then(() => {
        return;
    })
};

module.exports.deploy = async (event, context) => {
    // If the Lambda is cold, then we need to make sure that git and the awscli are untarred and ready to go...
    if (!(setupComplete)) {
        process.env.HOME = "/tmp"; // Needed for webpack...
        process.env.PATH = `${process.env.PATH}:/tmp/awscli:${path.join(__dirname, "node_modules/serverless/bin")}`; // Needed for awscli and serverless
        const waitForGit = setUpGit();
        const waitForCLI = cliSetup();
        const waitForIOTGateway = getIotGateway();
        try {
            await Promise.all([waitForGit, waitForCLI, waitForIOTGateway]);
            console.log("Lambda is warm -- call the shellscript...");
            if (!token) {
                const kms = new AWS.KMS({region: "us-west-2"});
                const data = await kms.decrypt({CiphertextBlob: Buffer(process.env.GIT_TOKEN, "base64")}).promise();
                token = data.Plaintext.toString("ascii");
                return runScript(event);
            } else {
                return runScript(event);
            }
        } catch (e) {
            console.log("Error:");
            console.log(e);
            return;
        }
    } else {
        return runScript(event);
    }
};

const cliSetup = () => {
    return new Promise((fullfill, reject) => {
        const reader = fs.createReadStream(path.join(__dirname, "awscli.tar"));
        reader.pipe(tar.extract("/tmp/awscli"));
        reader.on("end", fullfill());
    })
};

const runScript = async (event) => {
    console.log("Received the sns message to start...");
    const msg = JSON.parse(event.Records[0].Sns.Message);
    console.log(msg.git);
    const buildTime = msg.buildTime;
    // Create an entry in the build table...
    const params = {
        TableName: "builds",
        Item: {
            repo_name: msg.git.repo,
            build_start: buildTime,
            committer: {name: msg.git.commiter.name, email: msg.git.commiter.email},
            message: msg.git.commitMessage,
            hash: msg.git.commitHash,
            error: false
        }
    };
    const update = {
        type: "update", payload: params.Item
    };
    await stream.stream(params, `repos/${msg.git.repo}`, update, iotGateway);
    console.log("Created the build entry...");
    const tokenized = `${msg.git.clone_url.substring(0, 8)}${token}@${msg.git.clone_url.substring(8)}`;
    const cloneScript = spawn("sh", ["./clone.sh", tokenized, process.env.AWS_ENV]);

    cloneScript.stdout.on("data", async (data) => {
        console.log(data.toString());
        const p = {
            TableName: "build_step",
            Item: {
                repo_name: msg.git.repo,
                build_start: buildTime,
                build_step_time: (new Date).getTime(),
                output: data.toString(),
                type: "stdout"
            }
        };
        const update2 = {
            type: "new", payload: p.Item
        };
        await stream.stream(p, `repos/${msg.git.repo}/${buildTime}`, update2, iotGateway);
    });

    cloneScript.stderr.on("data", async (data) => {
        console.log(`STDERR: ${data.toString()}`);
        const p = {
            TableName: "build_step",
            Item: {
                repo_name: msg.git.repo,
                build_start: buildTime,
                build_step_time: (new Date).getTime(),
                output: data.toString(),
                type: "stderr"
            }
        };
        const update = {
            type: "new", payload: p.Item
        };
        await stream.stream(p, `repos/${msg.git.repo}/${buildTime}`, update, iotGateway);
    });

    cloneScript.on("exit", async (code) => {
        const endTime = (new Date).getTime();
        let errmsg = false;
        if (code !== 0) {
            errmsg = true;
        }
        const p = {
            TableName: "build_step",
            Item: {
                repo_name: msg.git.repo,
                build_start: buildTime,
                build_step_time: (new Date).getTime(),
                output: `Exited with code ${code.toString()}`,
                type: "end"

            }
        };
        const update = {
            type: "new", payload: p.Item
        };
        const Step1 = stream.stream(p, `repos/${msg.git.repo}/${buildTime}`, update, iotGateway);

        const p2 = {
            TableName: "build_lock",
            Item: {
                repo_name: msg.git.repo,
                start_time: buildTime,
                committer: {
                    name: msg.git.commiter.name,
                    email: msg.git.commiter.email
                },
                message: msg.git.commitMessage,
                hash: msg.git.commitHash,
                end_time: endTime,
                error: errmsg
            }
        };
        const update2 = {
            type: "update", payload: p.Item
        };
        const Step2 = stream.stream(p2, "repos", update2, iotGateway);
        const p3 = {
            TableName: "builds",
            Item: {
                repo_name: msg.git.repo,
                build_start: buildTime,
                end_time: endTime,
                committer: {name: msg.git.commiter.name, email: msg.git.commiter.email},
                message: msg.git.commitMessage,
                hash: msg.git.commitHash,
                error: errmsg
            }
        };
        const update3 = {type: "update", payload: p.Item};
        const Step3 = stream.stream(p3, `repos/${msg.git.repo}`, update3, iotGateway);
        try {
            await Promise.all([Step1, Step2, Step3]);
            return {};
        } catch (e) {
            console.log("Error:");
            console.log(e);
            return {};
        }
    });
};

module.exports.locks = async (event, context) => {
    const params = {
        TableName: "build_lock"
    };
    try {
        const data = await docClient.scan(params).promise();
        return {
            statusCode: 200,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Credentials": true
            },
            body: JSON.stringify(data.Items)
        };
    } catch (e) {
        console.log("Error:");
        console.log(e);
        return {
            statusCode: 500
        };
    }
};

module.exports.builds = async (event, context) => {
    const p = {
        TableName: "builds",
        KeyConditionExpression: "repo_name = :repo_name",
        ExpressionAttributeValues: {
            ":repo_name": event.pathParameters.repo
        }
    };
    try {
        const data = docClient.query(p).promise();
        return {
            statusCode: 200,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Credentials": true
            },
            body: JSON.stringify(data.Items)
        };
    } catch (e) {
        console.log("Error:");
        console.log(e);
        return {statusCode: 500};
    }
};

module.exports.steps = async (event, context) => {
    const p = {
        TableName: "build_step",
        IndexName: "BuildStart",
        KeyConditionExpression: "build_start = :build_start",
        ExpressionAttributeValues: {
            ":build_start": parseInt(event.pathParameters.build_start)
        }
    };
    try {
        const data = docClient.query(p).promise();
        return {
            statusCode: 200,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Credentials": true
            },
            body: JSON.stringify(data.Items)
        };
    } catch (e) {
        console.log("Error:");
        console.log(e);
        return {statusCode: 500};
    }
};

module.exports.iot = async (event, context) => {
    if (!iotGateway) {
        await getIotGateway();
        return await generateCredentials();
    } else {
        return generateCredentials();
    }
};

const generateCredentials = async () => {
    const sts = new AWS.STS();
    try {
        const data = sts.getCallerIdentity({}).promise();
        const params = {
            RoleArn: `arn:aws:iam::${data.Account}:role/stream-function-role`,
            RoleSessionName: getRandomInt().toString()
        };

        // assume role returns temporary keys
        const role = await sts.assumeRole(params).promise();
        const res = {
            statusCode: 200,
            headers: {
                "Access-Control-Allow-Origin": "*"
            },
            body: JSON.stringify({
                iotEndpoint: process.env.IOT_ENDPOINT,
                region: process.env.REGION,
                accessKey: role.Credentials.AccessKeyId,
                secretKey: role.Credentials.SecretAccessKey,
                sessionToken: role.Credentials.SessionToken
            })
        };
        return res;
    } catch (e) {
        console.log("Error:");
        console.log(e);
        return {statusCode: 500};
    }
};

const getRandomInt = () => {
    return Math.floor(Math.random() * 100000000);
};

const getIotGateway = async () => {
    const iot = new AWS.Iot();
    const data = await iot.describeEndpoint({}).promise();
    iotGateway = data.endpointAddress;
};