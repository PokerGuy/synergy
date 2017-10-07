const AWS = require('aws-sdk');
const docClient = new AWS.DynamoDB.DocumentClient({'region': 'us-west-2'});

const p = {
    TableName: 'build_step',
    IndexName: 'BuildStart',
    KeyConditionExpression: 'build_start = :build_start',
    ExpressionAttributeValues: {
        ':build_start': 1507400715295
    }
};
docClient.query(p, function (err, data) {
    if (err) {
        console.log(err);
    } else {
        console.log(data);
    }
});