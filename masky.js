// masky.js
const images = [
  "https://files.catbox.moe/3q2jfy.png",
  "https://files.catbox.moe/3q2jfy.png",
  "https://files.catbox.moe/h6z5uu.png",
  "https://files.catbox.moe/sdqimq.png",
  "https://files.catbox.moe/wtqmpn.png",
  "https://files.catbox.moe/7k4hun.png",
  "https://files.catbox.moe/tfjfuq.png",
  "https://files.catbox.moe/sdqimq.png",
  "https://files.catbox.moe/l3aiyj.png",
  "https://files.catbox.moe/vftjyw.png",
  "https://files.catbox.moe/9kbkft.png",
  "https://files.catbox.moe/yofo5o.png",
  "https://files.catbox.moe/l3aiyj.png",
  "https://files.catbox.moe/vftjyw.png",
  "https://files.catbox.moe/vftjyw.png",
  "https://files.catbox.moe/rckmq2.jpg",
  "https://files.catbox.moe/zfhbst.png"
];

function getImage() {
  const randomIndex = Math.floor(Math.random() * images.length);
  return images[randomIndex];
}

module.exports = getImage;
