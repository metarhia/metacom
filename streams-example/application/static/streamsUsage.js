'use strict';

const prepareContentContainers = () => {
  document.body.innerHTML = `
     <div><img id="image" width="100%"></div>
     <div><p id="text"></p></div>
   `;
};

const showImage = (blob) => {
  const image = document.getElementById('image');
  image.src = URL.createObjectURL(blob);
};

const showText = async (blob) => {
  const paragraph = document.getElementById('text');
  paragraph.textContent = await blob.text();
};

const downloadFile = async (name, type) => {
  const { producer, result } = await application.metacom.getStreamProducer(
    api.streams.fileStreamProducer, { name, type }
  );
  const blob = await producer.toBlob(result.type);
  return new File([blob], name);
};

const uploadFile = (file, name) => application.metacom.uploadBlob(
  file, api.streams.fileStreamConsumer, { name }
);

export const runStreams = async () => {
  prepareContentContainers();
  console.time('Image downloaded');
  const imagePromise = downloadFile('stream.jpg', 'image/jpg');
  console.time('Text downloaded');
  const textPromise = downloadFile('lorem.txt', 'text/plain');
  const results = await Promise.all([
    imagePromise.then((file) => {
      console.timeEnd('Image downloaded');
      showImage(file);
      console.time('Image uploaded');
      return uploadFile(file, 'stream-uploaded.jpg').then((result) => {
        console.timeEnd('Image uploaded');
        return result;
      });
    }),
    textPromise.then((file) => {
      console.timeEnd('Text downloaded');
      showText(file);
      console.time('Text uploaded');
      return uploadFile(file, 'lorem-uploaded.txt').then((result) => {
        console.timeEnd('Text uploaded');
        return result;
      });
    })
  ]);
  console.log(results);
};

// To test on-the-fly text insertion, uncomment code below
// export const runStreams = async () => {
//   prepareContentContainers();
//   const { producer, result } = await application.metacom.getStreamProducer(
//     api.streams.fileStreamProducer, { name: 'lorem.txt', type: 'text/plain' }
//   );
//   const paragraph = document.getElementById('text');
//   const decoder = new TextDecoder();
//   for await (const chunk of producer) {
//     paragraph.textContent += decoder.decode(chunk);
//   }
// }
