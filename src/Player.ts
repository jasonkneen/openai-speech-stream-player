interface Options {
  onPlaying?: () => void;
  onPause?: () => void;
  onChunkEnd?: () => void;
  mimeType?: string;
  audio?: HTMLAudioElement;
}

/**
 * @typedef {{ 
 *  onPlaying?: () => void; 
 *  onPause?: () => void; 
 *  onChunkEnd?: () => void; 
 *  mimeType?: string; 
 *  audio?: HTMLAudioElement 
 * }} Options
 */
class SpeechPlayer {
  /** @type { HTMLAudioElement } */
  _audio: HTMLAudioElement;
  /** @type { MediaSource } */
  mediaSource: MediaSource;
  /** @type { SourceBuffer } */
  sourceBuffer: SourceBuffer;
  /** @type {() => void } */
  initResolve: ((value: unknown) => void) | null;
  /** @type {Uint8Array[]} */
  sourceBufferCache: Uint8Array[] = [];
  /** @type {boolean} */
  destroyed: boolean = false;
  /** @type {boolean} */
  mediaSourceOpened: boolean = false;
  /** @type {Options} */
  options: Options = {};
  /** @type { AudioContext } */
  audioContext: AudioContext;
  /** @type { number } */
  nextStartTime: number = 0;
  /** @type { Uint8Array } */
  pendingBuffer: Uint8Array = new Uint8Array(0);
  /** @type { boolean } */
  useAudioContext: boolean = false;

  get audio() {
    return this._audio;
  }

  set audio(audio) {
    this._audio = audio;
  }

  /**
   * @param { Options } options
   */
  constructor(options?: Options) {
    if (options) {
      this.audio = options.audio || new Audio();
    } 
    this.options = options || {};
  }

  static async *streamAsyncIterable(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }

  async init() {
    this.destroyed = false;
    const mimeType = this.options?.mimeType ?? 'audio/mpeg';
    // Check if MediaSource is supported and can handle the mimeType
    if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mimeType)) {
      this.useAudioContext = false;
      return new Promise((resolve, reject) => {
        this.mediaSource = new MediaSource();
        this.audio.src = URL.createObjectURL(this.mediaSource);
        this.initResolve = resolve;
        this.mediaSource.addEventListener('sourceopen', this.sourceOpenHandle.bind(this));
      });
    } else {
      // Fallback to AudioContext for iOS Safari or other incompatible browsers
      this.useAudioContext = true;
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioContext();
      this.nextStartTime = 0;
      this.pendingBuffer = new Uint8Array(0);
      return Promise.resolve();
    }
  }

  sourceOpenHandle() {
    if (this.initResolve) {
      this.initResolve('');
      this.initResolve = null;
      URL.revokeObjectURL(this.audio.src);

      this.sourceBuffer = this.mediaSource.addSourceBuffer(this.options?.mimeType ?? 'audio/mpeg');
      let timer = 0;
      this.audio.addEventListener('playing', () => {
        this.options.onPlaying && this.options.onPlaying();
      });
      this.audio.addEventListener('pause', () => {
        this.options.onPause && this.options.onPause();
      });
      this.sourceBuffer.addEventListener('updateend', () => {
        timer && clearTimeout(timer);
        this.audio.paused && this.audio.play();
        (!this.sourceBuffer.updating
          && this.sourceBufferCache.length)
          && this.sourceBuffer.appendBuffer(this.sourceBufferCache.shift()! as unknown as BufferSource);
      });
      this.audio.addEventListener('waiting', () => {
        timer = setTimeout(() => {
          if (!this.sourceBuffer.updating
            && this.mediaSource.readyState === 'open'
            && this.sourceBufferCache.length === 0) {
            this.mediaSource.endOfStream();
            this.options.onChunkEnd && this.options.onChunkEnd();
          }
        }, 500);
      });
      this.mediaSourceOpened = true;
    }
  }

  /**
   * Feed audio chunk data into player with SourceBuffer created from MediaSource
   * @param {Uint8Array} chunk 
   */
  feed(chunk: Uint8Array) {
    if (this.destroyed) throw new ReferenceError('SpeechPlayer has been destroyed.');
    
    if (this.useAudioContext) {
      const newBuffer = new Uint8Array(this.pendingBuffer.length + chunk.length);
      newBuffer.set(this.pendingBuffer);
      newBuffer.set(chunk, this.pendingBuffer.length);
      this.pendingBuffer = newBuffer;
      this.processAudioContextQueue();
      return;
    }

    if (!this.mediaSourceOpened) throw new Error('MediaSource not opened, please do this update init resolved.');
    this.sourceBufferCache.push(chunk);
    !this.sourceBuffer.updating && this.sourceBuffer.appendBuffer(this.sourceBufferCache.shift()! as unknown as BufferSource);
  }

  async processAudioContextQueue() {
    if (this.pendingBuffer.length === 0) return;

    // Find the last potential sync word to ensure we don't cut in the middle of a frame
    // MP3 sync word is usually 0xFF followed by 0xE0 (11 bits set)
    let cutIndex = -1;
    for (let i = this.pendingBuffer.length - 2; i >= 0; i--) {
      if (this.pendingBuffer[i] === 0xFF && (this.pendingBuffer[i + 1] & 0xE0) === 0xE0) {
        cutIndex = i;
        break;
      }
    }

    if (cutIndex > 0) {
      const dataToDecode = this.pendingBuffer.slice(0, cutIndex);
      const remaining = this.pendingBuffer.slice(cutIndex);
      this.pendingBuffer = remaining;

      try {
        // Decode the audio data
        const audioBuffer = await this.audioContext.decodeAudioData(dataToDecode.buffer);
        this.schedulePlayback(audioBuffer);
        
        // Trigger onPlaying if it's the first chunk
        if (this.nextStartTime === 0 && this.options.onPlaying) {
            this.options.onPlaying();
        }
      } catch (e) {
        console.warn("Audio decode failed, keeping data in buffer", e);
        // If decoding fails, we might have cut incorrectly or data is bad. 
        // For now, we prepend the data back to pendingBuffer to try again with more data?
        // Or just drop it? Dropping is safer to avoid stuck loop.
        // But maybe we should just wait for more data.
        // Let's put it back.
        const recovered = new Uint8Array(dataToDecode.length + this.pendingBuffer.length);
        recovered.set(dataToDecode);
        recovered.set(this.pendingBuffer, dataToDecode.length);
        this.pendingBuffer = recovered;
      }
    }
  }

  schedulePlayback(buffer: AudioBuffer) {
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);

    let start = this.nextStartTime;
    if (start < this.audioContext.currentTime) {
      start = this.audioContext.currentTime;
    }
    source.start(start);
    this.nextStartTime = start + buffer.duration;
    
    source.onended = () => {
        // Check if we are done
        if (this.pendingBuffer.length === 0 && Math.abs(this.nextStartTime - this.audioContext.currentTime) < 0.1) {
            this.options.onChunkEnd && this.options.onChunkEnd();
        }
    };
  }

  /**
   * Feed audio chunk just with Fetch response and deal automaticlly.
   * @param {Response} response 
   */
  async feedWithResponse(response: Response) {
    for await (const chunk of SpeechPlayer.streamAsyncIterable(response.body as ReadableStream<Uint8Array>)) {
      this.feed(chunk);
    }
  }

  play(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      try {
        if (this.useAudioContext) {
          if (this.audioContext.state === 'suspended') {
            this.audioContext.resume().then(() => {
                this.options.onPlaying && this.options.onPlaying();
                resolve(true);
            });
          } else {
            resolve(true);
          }
          return;
        }

        if (this.paused) {
          this.audio.play();
          const playHandle = () => {
            resolve(true);
            this.audio.removeEventListener('playing', playHandle);
          };
          this.audio.addEventListener('playing', playHandle);
        } else {
          // audio not exist or audio status is playing will resolve false result.
          resolve(false);
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  pause(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      try {
        if (this.useAudioContext) {
          if (this.audioContext.state === 'running') {
            this.audioContext.suspend().then(() => {
                this.options.onPause && this.options.onPause();
                resolve(true);
            });
          } else {
            resolve(false);
          }
          return;
        }

        if (this.playing) {
          this.audio.pause();
          const pauseHandle = () => {
            this.audio.removeEventListener('pause', pauseHandle);
            resolve(true);
          };
          this.audio.addEventListener('pause', pauseHandle);
          // puase event must be fired before setTimeout.
          setTimeout(() => {
            resolve(this.paused);
          }, 0);
        } else {
          // audio not exist or audio status is paused will resolve false result.
          resolve(false);
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  get paused() {
    if (this.useAudioContext) {
      return this.audioContext.state === 'suspended' || this.audioContext.state === 'closed';
    }
    return this.audio && this.audio.paused;
  }

  get playing() {
    return !this.paused;
  }

  /**
   * Destroy speechPlayer instance, if want play again, need do init method again.
   */
  destroy() {
    if (this.useAudioContext) {
      this.audioContext.close();
      this.destroyed = true;
      return;
    }
    if (this.audio && this.audio.paused === false) this.audio.pause();
    this.destroyed = true;
    this.mediaSourceOpened = false;
    this.mediaSource && this.mediaSource.removeSourceBuffer(this.sourceBuffer as SourceBuffer);
    this.mediaSource && this.mediaSource.endOfStream();
    this.sourceBuffer.abort();
    this.sourceBufferCache.splice(0);
  }
}

export { SpeechPlayer };
