const GitKit = require('gitkit');
const NodeFS = require('gitkit/lib/fs/node');

// Prepare the filesystem
const fs = new NodeFS('/Users/evan.zlotnick/tempclone');

// Create a repository instance
const repo = GitKit.Repository.createWithFS(fs);

const transport = new GitKit.HTTPTransport('https://github.com/PokerGuy/react-boilerplate.git');
GitKit.RepoUtils.init(repo)
    .then(function() {
        return GitKit.TransferUtils.clone(repo, transport);
    })
    .then(
        function() {
            console.log('Success! Sweet!');
        },
        function(err) {
            console.log('D\' Oh!');
            console.log(err);
        },

        // Progress
        function(line) {
            console.log(line.getMessage());
        }
    );