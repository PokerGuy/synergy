#!/bin/bash
CLONE_URL=$1
AWS_ENV=$2

rm -rf /tmp/clone

cd /tmp

echo "Cloning from git..."

if [ "$AWS_ENV" == "prod" ]; then
    git clone -b master --single-branch $CLONE_URL clone
else
    git clone -b $AWS_ENV --single-branch $CLONE_URL clone
fi

cd /tmp/clone

echo "Running the deploy script"

./deploy.sh $AWS_ENV
