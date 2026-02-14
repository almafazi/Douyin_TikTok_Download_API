import mongoose from 'mongoose';

const downloadSchema = new mongoose.Schema({
  userId: {
    type: Number,
    required: true,
    index: true
  },
  url: {
    type: String,
    required: true
  },
  contentType: {
    type: String,
    enum: ['video', 'audio', 'slideshow', 'photo'],
    required: true
  },
  quality: {
    type: String,
    enum: ['HD', 'SD', 'MP3', 'original'],
    default: 'original'
  },
  success: {
    type: Boolean,
    required: true
  },
  fileSize: {
    type: Number,
    default: null
  },
  duration: {
    type: Number,
    default: null
  },
  errorMessage: {
    type: String,
    default: null
  },
  processingTime: {
    type: Number,
    default: null
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

downloadSchema.index({ timestamp: -1 });
downloadSchema.index({ userId: 1, timestamp: -1 });
downloadSchema.index({ contentType: 1, timestamp: -1 });
downloadSchema.index({ success: 1, timestamp: -1 });

export const Download = mongoose.model('Download', downloadSchema);
export default Download;
