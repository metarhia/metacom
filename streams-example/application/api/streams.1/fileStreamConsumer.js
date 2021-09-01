({
  access: 'public',
  method: async ({ streamId, name = 'test.txt'  }) => {
    const filePath = `./application/resources/${name}`;
    const readable = context.client.getStream(streamId);
    const writable = node.fs.createWriteStream(filePath);
    return readable.pipe(writable);
  }
});
