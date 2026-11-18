export async function decodeTileImage(blob, options) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, options);
    } catch (error) {
      // A worker has no image element to use as the fallback decoder.
      if (typeof Image === 'undefined') throw error;
    }
  }
  if (typeof Image === 'undefined') throw new Error('瓦片解码不可用');
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('瓦片解码失败'));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
