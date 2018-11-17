const {spawn} = require("child_process");
const crypto = require("crypto");
const AWS = require("aws-sdk");
const fs = require("fs");
const path = require("path");
const tar = require("tar-fs");
const async = require("async");
const config = require("./config");
const _ = require("lodash");
const axios = require("axios");
const docClient = new AWS.DynamoDB.DocumentClient({"region": "us-west-2"});
const stream = require("./streamAndSave");
let setupComplete = false;

//Used to determine if the lambda is hot or cold
const encrypted = process.env.GIT_SECRET;
let decrypted;
let token;

function checkGitSecret(event, context, callback) {
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
            let cont = false;
            docClient.query(p, (err, data) => {
                let newRepo = false;
                if (err) {
                    done(err);
                } else if (data.Count > 0) {
                    // We already have a build lock
                    lock = data.Items[0];
                    if (lock.end_time === undefined && lock.start_time > (currTime - (5 * 60 * 1000))) {
                        // There is no end time on the lock and the start time was < 5 minutes ago... Assume another build is going on...
                        console.log("Currently doing a build... Wait!");
                        const response = {
                            statusCode: 409,
                            body: JSON.stringify({msg: "Currently doing a build."})
                        };
                        callback(null, response);
                    } else {
                        // There has been a build before, so let us do an update...
                        console.log("Modifying an existing build...");
                        delete lock["end_time"];
                        cont = true;
                    }
                } else {
                    // Never built this repo before...
                    console.log("New build!");
                    lock.repo_name = repo;
                    cont = true;
                    newRepo = true;
                }
                if (cont) {
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
                    stream.stream(lockItem, "repos", {type: type, payload: lock}, iotGateway, () => {
                        const sns = new AWS.SNS();
                        sns.publish(params, (err, data) => {
                            if (err) {
                                console.log(err);
                            } else {
                                console.log("Sent message to trigger build");
                                callback(null, {"statusCode": 200});
                            }
                        });
                    });
                }
            });
        } else {
            const url = _.find(config, (c) => {
                return c.env == branch;
            });
            if (url !== undefined) {
                // Not the right environment, so let's send it to the right place and call it a day...
                console.log("Found details where to send this message...");
                console.log(url);
                axios.post(url.url, event.body, {
                    headers: {
                        "X-Hub-Signature": event.headers["X-Hub-Signature"],
                        "Content-type": "application/json"
                    }
                }).then((response) => {
                    console.log(response);
                    callback(null, {"statusCode": 200});
                }).catch((err) => {
                    console.log(err);
                    callback(null, {"statusCode": 200});
                })
            } else {
                console.log(`${branch} must be a feature branch. Do nothing...`);
                callback(null, {"statusCode": 200});
            }
        }
    } else {
        callback(null, {
            "statusCode": 401
        })
    }
}

module.exports.authenticate = (event, context, callback) => {
    if (decrypted) {
        //The lambda is warm and decrypted has the secret value in plain text in memory
        //Don't be stupid and expose it in a log!
        checkGitSecret(event, context, callback);
    } else {
        //Lambda is cold, need to decrypt the environmental variable and keep the plain text value in memory...
        const kms = new AWS.KMS({region: "us-west-2"});
        kms.decrypt({CiphertextBlob: Buffer(encrypted, "base64")}, (err, data) => {
            if (err) {
                console.log(`Decrypt error: ${err}`);
                return callback(err);
            }
            decrypted = data.Plaintext.toString("ascii");
            checkGitSecret(event, context, callback);
        });
    }
};

module.exports.deploy = (event, context, callback) => {
    // If the Lambda is cold, then we need to make sure that git and the awscli are untarred and ready to go...
    if (!(setupComplete)) {
        process.env.HOME = "/tmp"; // Needed for webpack...
        process.env.PATH = `${process.env.PATH}:/tmp/awscli:${path.join(__dirname, "node_modules/serverless/bin")}`; // Needed for awscli and serverless
        async.parallel([
            (done) => {
                require("lambda-git")().then(() => {
                    console.log("Git is now ready to go...");
                    done();
                })
            },
            (done) => {
                cliSetup(done);
            },
            (done) => {
                if (!iotGateway) {
                    getIotGateway(() => {
                        done();
                    })
                } else {
                    done();
                }
            }
        ], (err) => {
            if (err) {
                console.log("Oh Snap!");
                console.log(err);
                callback();
            } else {
                console.log("Lambda is warm -- call the shellscript...");
                if (!token) {
                    const kms = new AWS.KMS({region: "us-west-2"});
                    kms.decrypt({CiphertextBlob: Buffer(process.env.GIT_TOKEN, "base64")}, (err, data) => {
                        if (err) {
                            console.log(`Decrypt error: ${err}`);
                            return callback(err);
                        }
                        token = data.Plaintext.toString("ascii");
                        runScript(event, callback);
                    })
                } else {
                    runScript(event, callback);
                }
            }
        });
    }
};

function cliSetup(cb) {
    const reader = fs.createReadStream(path.join(__dirname, "awscli.tar"));
    reader.pipe(tar.extract("/tmp/awscli"));
    reader.on("end", cb);
}

function runScript(event, callback) {
    console.log("Received the sns message to start...");
    const msg = JSON.parse(event.Records[0].Sns.Message);
    console.log(msg.git);
    buildTime = msg.buildTime;
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
    stream.stream(params, `repos/${msg.git.repo}`, update, iotGateway, () => {
        console.log("Created the build entry...");
        const tokenized = `${msg.git.clone_url.substring(0, 8)}${token}@${msg.git.clone_url.substring(8)}`;
        const cloneScript = spawn("sh", ["./clone.sh", tokenized, process.env.AWS_ENV]);

        cloneScript.stdout.on("data", (data) => {
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
            stream.stream(p, `repos/${msg.git.repo}/${buildTime}`, update2, iotGateway, () => {
            });
        });

        cloneScript.stderr.on("data", (data) => {
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
            stream.stream(p, `repos/${msg.git.repo}/${buildTime}`, update, iotGateway, () => {
            });
        });

        cloneScript.on("exit", (code) => {
            const endTime = (new Date).getTime();
            let errmsg = false;
            if (code !== 0) {
                errmsg = true;
            }
            async.parallel([
                (done) => {
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
                    stream.stream(p, `repos/${msg.git.repo}/${buildTime}`, update, iotGateway, () => {
                        done();
                    });
                },
                (done) => {
                    const p = {
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
                    const update = {
                        type: "update", payload: p.Item
                    };
                    stream.stream(p, "repos", update, iotGateway, () => {
                        done();
                    });
                },
                (done) => {
                    const p = {
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
                    const update = {
                        type: "update", payload: p.Item
                    };
                    stream.stream(p, `repos/${msg.git.repo}`, update, iotGateway, () => {
                        done();
                    });
                }
            ], (err) => {
                if (err) {
                    console.log(err);
                }
                callback();
            });
        });
    });
}

module.exports.locks = (event, context, callback) => {
    const params = {
        TableName: "build_lock"
    };
    docClient.scan(params, (err, data) => {
        if (err) {
            console.log(err);
        } else {
            response = {
                statusCode: 200,
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Credentials": true
                },
                body: JSON.stringify(data.Items)
            }
        }
        callback(null, response);
    })
};

module.exports.builds = (event, context, callback) => {
    const p = {
        TableName: "builds",
        KeyConditionExpression: "repo_name = :repo_name",
        ExpressionAttributeValues: {
            ":repo_name": event.pathParameters.repo
        }
    };
    docClient.query(p, (err, data) => {
        if (err) {
            console.log(err);
        } else {
            response = {
                statusCode: 200,
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Credentials": true
                },
                body: JSON.stringify(data.Items)
            };
            callback(null, response);
        }
    })
};

module.exports.steps = (event, context, callback) => {
    const p = {
        TableName: "build_step",
        IndexName: "BuildStart",
        KeyConditionExpression: "build_start = :build_start",
        ExpressionAttributeValues: {
            ":build_start": parseInt(event.pathParameters.build_start)
        }
    };
    docClient.query(p, (err, data) => {
        if (err) {
            console.log(err);
        } else {
            response = {
                statusCode: 200,
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Credentials": true
                },
                body: JSON.stringify(data.Items)
            };
            callback(null, response);
        }
    })
};

module.exports.iot = (event, context, callback) => {
    generateCredentials(callback);
};

function generateCredentials(callback) {
    const sts = new AWS.STS();
    // get the account id which will be used to assume a role
    sts.getCallerIdentity({}, (err, data) => {
        if (err) return callback(err);

        const params = {
            RoleArn: `arn:aws:iam::${data.Account}:role/stream-function-role`,
            RoleSessionName: getRandomInt().toString()
        };

        // assume role returns temporary keys
        sts.assumeRole(params, (err, data) => {
            if (err) return callback(err);
            const res = {
                statusCode: 200,
                headers: {
                    "Access-Control-Allow-Origin": "*"
                },
                body: JSON.stringify({
                    iotEndpoint: process.env.IOT_ENDPOINT,
                    region: process.env.REGION,
                    accessKey: data.Credentials.AccessKeyId,
                    secretKey: data.Credentials.SecretAccessKey,
                    sessionToken: data.Credentials.SessionToken
                })
            };
            callback(null, res);
        })
    })
}

const getRandomInt = () => {
    return Math.floor(Math.random() * 100000000);
};