({
  access: 'public',
  method: async ({ name = 'test.txt', type = 'text/plain' }) => {
    const filePath = `./application/resources/${name}`;
    const readable = node.fs.createReadStream(filePath);
    const { size } = await node.fsp.stat(filePath);
    const writable = context.client.createStream(name, size);
    readable.pipe(writable);
    return { streamId: writable.streamId, type };
  }
});
