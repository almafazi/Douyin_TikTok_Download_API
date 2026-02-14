import mongoose from 'mongoose';

const errorSchema = new mongoose.Schema({
  userId: {
    type: Number,
    default: null,
    index: true
  },
  errorType: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  stack: {
    type: String,
    default: null
  },
  context: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

errorSchema.index({ timestamp: -1 });
errorSchema.index({ errorType: 1, timestamp: -1 });
errorSchema.index({ userId: 1, timestamp: -1 });

export const ErrorLog = mongoose.model('ErrorLog', errorSchema);
export default ErrorLog;
