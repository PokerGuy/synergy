#!/bin/bash
AWS_ENV=$1

cd /tmp/clone

serverless deploy --AWS_ENV $AWS_ENV