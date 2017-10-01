The following assumptions are made:  
* There can be any number of branches
* Branches correspond to an environment
* There will always be a prod environment and the branch that maps to prod will be master
* To configure additional branches, modify the config.js file
* If an environment and URL are not in this file, then the merge is assumed to be in a feature branch and no deployment will happen

This module depends on node and serverless. From a Mac:
```
brew install node
npm install -g serverless
```

Make sure you have your AWS Credentials for each environment. Before you do the inital deployment for a given environment:
```
export AWS_ACCESS_KEY_ID=<your access key>
export AWS_SECRET_ACCESS_KEY=<your secret access key>
```

Comment out these lines in the serverless.yml:  
Under lambdaKey
```
            -
              Sid: "Lambda Role"
              Effect: "Allow"
              Principal:
                AWS: "arn:aws:iam::${file(./serverless.env.yml):${opt:AWS_ENV}.aws_account_number}:role/${self:service}-${opt:AWS_ENV}-us-west-2-lambdaRole"
              Action:
                - "kms:Decrypt"
              Resource: "*"
```
Under iamRoleStatements:
```
    - Effect: "Allow"
      Action:
        - "kms:Decrypt"
      Resource: 'arn:aws:kms:us-west-2:${file(./serverless.env.yml):${opt:AWS_ENV}.aws_account_number}:key/${file(./serverless.env.yml):${opt:AWS_ENV}.key_guid}'
```

Do a ```serverless deploy```

Go to the AWS Console and find the KMS Key that was just created.

```
aws kms encrypt --key-id <your key> --plaintext <your secret>
```

Configure the serverless.env.yml to have your the key guid, AWS account ID, and the encrypted secret from the above step.  

Redeploy. Follow the steps to deploy into your other environments. Configure the config.js according with the URL for the githook function.  

In your github repositories, set up an action hook and make sure the payload is sent in json not form encoded.  

The following are a part of this library:  
* Git
* AWSCLI
* Serverless

Any repository pointing to the githook URL will be cloned into the Lambda. It will then look for a deploy.sh script and execute it. 
If you want to deploy infrastructure, you can use Cloud Formation with Serverless. Anything in the deploy.sh will be done from compiling to moving builds to S3 or other environments.
