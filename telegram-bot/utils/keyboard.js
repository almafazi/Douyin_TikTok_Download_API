import { storeUrl } from './redis.js';

/**
 * Build video download keyboard
 * @param {Object} downloadLinks - Download links object
 * @returns {Promise<Array>}
 */
export async function buildVideoKeyboard(downloadLinks) {
  const keyboard = [];

  // Video quality options (store URLs in Redis)
  if (downloadLinks.no_watermark_hd) {
    const id = await storeUrl(downloadLinks.no_watermark_hd);
    keyboard.push([
      { text: '📹 HD (No Watermark)', callback_data: `dl:video:${id}` }
    ]);
  }

  if (downloadLinks.no_watermark) {
    const id = await storeUrl(downloadLinks.no_watermark);
    keyboard.push([
      { text: '📹 SD (No Watermark)', callback_data: `dl:video:${id}` }
    ]);
  }

  if (downloadLinks.watermark) {
    const id = await storeUrl(downloadLinks.watermark);
    keyboard.push([
      { text: '📹 With Watermark', callback_data: `dl:video:${id}` }
    ]);
  }

  // Audio option
  if (downloadLinks.mp3) {
    const id = await storeUrl(downloadLinks.mp3);
    keyboard.push([
      { text: '🎵 Audio MP3', callback_data: `dl:mp3:${id}` }
    ]);
  }

  return keyboard;
}

/**
 * Build slideshow download keyboard
 * @param {Object} downloadLinks - Download links object
 * @param {string} slideshowUrl - Slideshow download URL
 * @param {Array} photos - Array of photo URLs
 * @returns {Promise<Array>}
 */
export async function buildSlideshowKeyboard(downloadLinks, slideshowUrl, photos) {
  const keyboard = [];

  // Individual photo download buttons
  if (photos && photos.length > 0) {
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      const id = await storeUrl(photo.url);
      keyboard.push([
        { text: `📷 Download Photo ${i + 1}`, callback_data: `photo:${id}` }
      ]);
    }
  }

  // Slideshow video option
  if (slideshowUrl) {
    const id = await storeUrl(slideshowUrl);
    keyboard.push([
      { text: '🎬 Download as Video', callback_data: `ss:${id}` }
    ]);
  }

  // Audio option
  if (downloadLinks.mp3) {
    const id = await storeUrl(downloadLinks.mp3);
    keyboard.push([
      { text: '🎵 Audio MP3', callback_data: `dl:mp3:${id}` }
    ]);
  }

  return keyboard;
}

/**
 * Build cancel button
 * @returns {Array}
 */
export function buildCancelButton() {
  return [{ text: '❌ Cancel', callback_data: 'cancel' }];
}

/**
 * Build confirmation keyboard
 * @param {string} confirmData - Callback data for confirm
 * @param {string} cancelData - Callback data for cancel
 * @returns {Array}
 */
export function buildConfirmationKeyboard(confirmData, cancelData = 'cancel') {
  return [
    [
      { text: '✅ Yes', callback_data: confirmData },
      { text: '❌ No', callback_data: cancelData }
    ]
  ];
}

/**
 * Combine keyboard rows
 * @param {...Array} keyboards - Keyboard arrays
 * @returns {Array}
 */
export function combineKeyboards(...keyboards) {
  return keyboards.flat();
}

/**
 * Build inline keyboard with common layout
 * @param {Array} buttons - Array of button objects {text, callback_data, url}
 * @param {number} columns - Number of columns
 * @returns {Array}
 */
export function buildInlineKeyboard(buttons, columns = 2) {
  const keyboard = [];

  for (let i = 0; i < buttons.length; i += columns) {
    const row = buttons.slice(i, i + columns).map(btn => {
      const button = { text: btn.text };
      if (btn.callback_data) button.callback_data = btn.callback_data;
      if (btn.url) button.url = btn.url;
      return button;
    });
    keyboard.push(row);
  }

  return keyboard;
}
