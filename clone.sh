#!/bin/bash
CLONE_URL=$1
AWS_ENV=$2

rm -rf /tmp/clone

cd /tmp

if [ "$AWS_ENV" == "prod" ]; then
    git clone -b master --single-branch $CLONE_URL clone
else
    git clone -b $AWS_ENV --single-branch $CLONE_URL clone
fi

cd /tmp/clone

pwd

echo "This is what we have in the /tmp/clone directory"

ls

echo "Running the deploy script"

./deploy.sh $AWS_ENV