/* const spawn = require('child_process').spawn;


let shellScript = spawn('sh ./clone.sh', ['yolo']);

shellScript.stdout.on('data', function (data) {
    console.log(data.toString());
});

shellScript.stderr.on('data' + function (data) {
        console.log('STDERR: ' + data.toString());
    });

shellScript.on('exit', function (code) {
    console.log('Exited with code ' + code.toString());
    console.log('Ending the Lambda now...');
    callback(null, response);
}); */

const { spawn } = require('child_process');

const child = spawn('sh', ['hello.sh', 'yolo']);

child.stdout.on('data', (data) => {
    console.log(`child stdout:\n${data}`);
});
