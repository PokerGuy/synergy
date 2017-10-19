const AWS = require('aws-sdk');
const async = require('async');
const docClient = new AWS.DynamoDB.DocumentClient({'region': 'us-west-2'});

module.exports.stream = (document, topic, stream, gateway, cb) => {
    async.parallel([
        function(done) {
            //Store in Dynamo
            docClient.put(document, function (err, data) {
                if (err) {
                    done(err);
                } else {
                    done();
                }
            })
        },
        function(done) {
            //Stream over IOT
            const iotData = new AWS.IotData({ endpoint: gateway });
            const params = {
                topic: topic,
                payload: JSON.stringify(stream)
            };
            iotData.publish(params, (err, res) => {
                if (err) done(err);

                done();
            })
        }
    ], function(err) {
        if (err) {
            console.log(err);
        }
        cb();
    })
};