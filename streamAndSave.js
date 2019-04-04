const AWS = require('aws-sdk');
const docClient = new AWS.DynamoDB.DocumentClient({'region': 'us-west-2'});

module.exports.stream = async (document, topic, stream, gateway) => {
    try {
        const storeInDynamo = docClient.put(document).promise();
        const iotData = new AWS.IotData({endpoint: gateway});
        const params = {
            topic: topic,
            payload: JSON.stringify(stream)
        };
        const streamMsg = iotData.publish(params).promise();
        const promises = await Promise.all([storeInDynamo, streamMsg]);
        return;
    } catch (e) {
        console.log("Error:");
        console.log(e);
        return;
    }
};