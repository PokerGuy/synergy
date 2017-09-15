#!/bin/bash
echo "Received the parameter ${1}"

tar

cd /tmp

git clone $1 clone

cd /tmp/clone

pwd

echo "This is what we have in the /tmp/clone directory"

ls

./deploy.sh