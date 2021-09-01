# Metacom streams example

### Installation
`npm install`

*Make sure you're installing metacom test version from `metastream` branch as it's resolved by npm-force-resolutions*

### Start
`node server.js`

### Investigate results
1. Go to http://localost:8000
2. You will a picture and text
3. Open devtools console
   - Check benchmark logs
   - Check websocket messages in Network tab
4. Check uploaded files in `application/resources`
5. Play with client interfaces in `application/static/streamsUsage.js`

### How to use streams
1. If you want to upload a big binary:
   1. On server:
      - Create an `apiConsumerInterface` like `api/streams.1/fileStreamConsumer.js`, **important: make sure you pass `streamId` to the consumer, so that it can identify stream**
   2. On client:
      - Use `application.metacom.createStreamConsumer(name, size, apiConsumerInterface, ?args)`, then write bytes to consumer and await for result
      - or use `application.metacom.uploadBlob(blob, apiConsumerInterface, ?args)` to upload Blob or File
2. If you want to download a big binary:
   1. On server:
      - Create an `apiProducerInterface` like `api/streams.1/fileStreamProducer.js`, **important: make sure you return `{ streamId }` from the producer, so that client can identify stream**
   2. On client:
      - Use `application.metacom.getStreamProducer(apiProducerInterface, ?args)` and then read bytes from producer
      - or use `await producer.toBlob(?type)` to create a Blob from producer
