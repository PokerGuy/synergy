const { spawn } = require('child_process');

module.exports.hello = (event, context, callback) => {
    const response = {
        statusCode: 200,
        body: JSON.stringify({
            message: 'Go Serverless v1.0! Your function executed successfully!'
        }),
    };
    require('lambda-git')().then(function() {
        console.log('Git is now ready to go...');
        console.log('Our path is now:');
        console.log(process.env.PATH);
        const parsed = JSON.parse(event.body);
        console.log('The github url is:');
        console.log(parsed.repository.html_url);
        console.log('Going to clone the repo to /tmp now...');
        process.env.HOME = '/tmp';

        const shellScript = spawn('sh', ['./clone.sh', parsed.repository.html_url + '.git']);

        shellScript.stdout.on('data', function(data) {
            console.log(data.toString());
        });

        shellScript.stderr.on('data' + function(data) {
            console.log('STDERR: ' + data.toString());
            });

        shellScript.on('exit', function(code) {
            console.log('Exited with code ' + code.toString());
            console.log('Ending the Lambda now...');
            callback(null, response);
        })
    });
};
