const exec = require('child_process').exec;

module.exports.hello = (event, context, callback) => {
    const response = {
        statusCode: 200,
        body: JSON.stringify({
            message: 'Go Serverless v1.0! Your function executed successfully!'
        }),
    };
    require('lambda-git')().then(function() {
        console.log('Git is now ready to go...')
        console.log('Our path is now:');
        console.log(process.env.PATH);
        const parsed = JSON.parse(event.body);
        console.log('The github url is:');
        console.log(parsed.repository.html_url);
        console.log('Going to clone the repo to /tmp now...');
        process.env.HOME = '/tmp';


        exec('sh ./clone.sh ' + parsed.repository.html_url + '.git', function (error, stdout, stderr) {
            console.log('The error was:');
            console.log(error);
            console.log('The stdout was:');
            console.log(stdout);
            console.log('The stderr was:');
            console.log(stderr);
            console.log('Going to send the response back and end the lambda');
            callback(null, response);
        });
    });
};
