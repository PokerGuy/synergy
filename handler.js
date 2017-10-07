const {spawn} = require('child_process');
const crypto = require('crypto');
const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');
const tar = require('tar-fs');
const async = require('async');
const config = require('./config');
const _ = require('lodash');
const axios = require('axios');
const docClient = new AWS.DynamoDB.DocumentClient({'region': 'us-west-2'});
let setupComplete = false;

//Used to determine if the lambda is hot or cold
const encrypted = process.env.GIT_SECRET;
let decrypted;

function checkGitSecret(event, context, callback) {
    let hash, hmac;
    const signature = event.headers['X-Hub-Signature'];
    const calculatedSignature = `sha1=${crypto.createHmac('sha1', decrypted).update(event.body, 'utf-8').digest('hex')}`;
    if (signature === calculatedSignature) {
        const parsed = JSON.parse(event.body);
        let branch = parsed.ref.split('/')[2];
        if (branch === 'master') {
            branch = 'prod';
        }
        console.log('Received a message from branch ' + branch);
        if (branch === process.env.AWS_ENV) {
            console.log('We are in the right branch... Triggering the SNS message.');
            // We are in the right environment, trigger the deployment...
            const repo = parsed.repository.full_name.split('/')[1];
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
            const msg = {
                git: details
            };
            const params = {
                Message: JSON.stringify(msg),
                TargetArn: 'arn:aws:sns:us-west-2:' + process.env.AWS_ACCOUNT_NUMBER + ':' + process.env.AWS_ENV + '-clone'
            };
            const p = {
                TableName: 'build_lock',
                KeyConditionExpression: 'repo_name = :repo_name',
                ExpressionAttributeValues: {
                    ':repo_name': repo
                }
            };
            let lock = {};
            docClient.query(p, function (err, data) {
                if (err) {
                    console.log('Got an error querying dynamo');
                } else if (data.Count > 0) {
                    // We already have a build lock
                    lock = data.Items[0];
                    if (lock.end_time === undefined && lock.start_time > ((new Date).getTime() - (5 * 60 * 1000))) {
                        // There is no end time on the lock and the start time was < 5 minutes ago... Assume another build is going on...
                        console.log('Currently doing a build... Wait!');
                        const response = {
                            statusCode:409,
                            body: JSON.stringify({msg: 'Currently doing a build.'})
                        };
                        callback(null, response);
                    } else {
                        // There has been a build before, so let us do an update...
                        console.log('Modifying an existing build...');
                        delete lock['end_time'];
                    }
                } else {
                    // Never built this repo before...
                    console.log('New build!');
                    lock.repo_name = repo;
                }
                lock.start_time = (new Date).getTime();
                lock.committer = {name: parsed.head_commit.committer.name, email: parsed.head_commit.committer.email};
                lock.message = parsed.head_commit.message;
                lock.hash = parsed.after;
                lock.error = false;
                const lockItem = {
                    TableName: 'build_lock',
                    Item: lock
                };
                docClient.put(lockItem, function(err, data) {
                    if (err) {
                        console.log('Error creating lock...')
                    } else {
                        const sns = new AWS.SNS();
                        sns.publish(params, function (err, data) {
                            if (err) {
                                console.log(err);
                            } else {
                                console.log('Sent message to trigger build');
                            }
                            callback(null, {
                                "statusCode": 200
                            });
                        });
                    }
                })
            });
        } else {
            const url = _.find(config, function(c) {
                return c.env == branch;
            });
            if (url !== undefined) {
                // Not the right environment, so let's send it to the right place and call it a day...
                console.log('Found details where to send this message...');
                console.log(url);
                axios.post(url.url, event.body, {
                    headers: {
                        'X-Hub-Signature': event.headers['X-Hub-Signature'],
                        'Content-type': 'application/json'
                    }
                }).then(function (response) {
                    console.log(response);
                    callback(null, {"statusCode": 200});
                }).catch(function (err) {
                    console.log(err);
                    callback(null, {"statusCode": 200});
                })
            } else {
                console.log(branch + ' must be a feature branch. Do nothing...');
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
        console.log('Encrypted is:');
        console.log(encrypted);
        const kms = new AWS.KMS({region: 'us-west-2'});
        kms.decrypt({CiphertextBlob: Buffer(encrypted, 'base64')}, (err, data) => {
            if (err) {
                console.log('Decrypt error:', err);
                return callback(err);
            }
            decrypted = data.Plaintext.toString('ascii');
            checkGitSecret(event, context, callback);
        });
    }
};

module.exports.deploy = (event, context, callback) => {
    // If the Lambda is cold, then we need to make sure that git and the awscli are untarred and ready to go...
    if (!(setupComplete)) {
        process.env.HOME = '/tmp'; // Needed for webpack...
        process.env.PATH = process.env.PATH + ':' + '/tmp/awscli:' + path.join(__dirname, 'node_modules/serverless/bin'); // Needed for awscli and serverless
        async.parallel([
            function (done) {
                require('lambda-git')().then(function () {
                    console.log('Git is now ready to go...');
                    done();
                })
            },
            function (done) {
                cliSetup(done);
            }
        ], function (err) {
            if (err) {
                console.log('Oh Snap!');
                console.log(err);
                callback();
            } else {
                console.log('Lambda is warm -- call the shellscript...');
                runScript(event, callback);
            }
        });
    }
};

function cliSetup(cb) {
    const reader = fs.createReadStream(path.join(__dirname, 'awscli.tar'));
    reader.pipe(tar.extract('/tmp/awscli'));
    reader.on('end', cb);
}

function runScript(event, callback) {
    console.log('Received the sns message to start...');
    const msg = JSON.parse(event.Records[0].Sns.Message);
    console.log(msg.git);
    const cloneScript = spawn('sh', ['./clone.sh', msg.git.clone_url, process.env.AWS_ENV]);

    cloneScript.stdout.on('data', function (data) {
        console.log(data.toString());
    });

    cloneScript.stderr.on('data', function (data) {
        console.log('STDERR: ' + data.toString());
    });

    cloneScript.on('exit', function (code) {
        console.log('Exited with code ' + code.toString());
        console.log('Ending the Lambda now...');
        callback();
    });
}
