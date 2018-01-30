#!/bin/bash
AWS_ENV=$1

cd /tmp

rm -r *

cd /tmp/clone

npm install

serverless deploy --AWS_ENV $AWS_ENV