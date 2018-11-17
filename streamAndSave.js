const AWS = require('aws-sdk');
const async = require('async');
const docClient = new AWS.DynamoDB.DocumentClient({'region': 'us-west-2'});

module.exports.stream = (document, topic, stream, cb) => {
    async.parallel([
        function(done) {
            //Store in Dynamo
            docClient.put(document, function (err, data) {
                if (err) {
                    done(err);
                } else {
                    console.log('inserted the document');
                    done();
                }
            })
        },
        function(done) {
            //Stream over IOT
            console.log('topic ' + topic);
            console.log('stream ' + stream);
            const iotData = new AWS.IotData({ endpoint: process.env.IOT_GATEWAY });
            const params = {
                topic: topic,
                payload: JSON.stringify(stream)
            };
            iotData.publish(params, (err, res) => {
                if (err) {
                    done(err);
                } else {
                    console.log('Sent the stream');
                    done();
                }
            })
        }
    ], function(err) {
        if (err) {
            console.log(err);
        }
        console.log('finished the stream and the document');
        cb();
    })
};