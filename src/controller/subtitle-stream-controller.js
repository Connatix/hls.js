/**
 * @class SubtitleStreamController
 */

import Event from '../events';
import { logger } from '../utils/logger';
import Decrypter from '../crypt/decrypter';
import { BufferHelper } from '../utils/buffer-helper';
import { findFragmentByPDT, findFragmentByPTS } from './fragment-finders';
import { FragmentState } from './fragment-tracker';
import BaseStreamController, { State } from './base-stream-controller';
import { mergeSubtitlePlaylists } from './level-helper';

const { performance } = window;
const TICK_INTERVAL = 500; // how often to tick in ms

export class SubtitleStreamController extends BaseStreamController {
  constructor (hls, fragmentTracker) {
    super(hls,
      Event.MEDIA_ATTACHED,
      Event.MEDIA_DETACHING,
      Event.ERROR,
      Event.KEY_LOADED,
      Event.FRAG_LOADED,
      Event.SUBTITLE_TRACKS_UPDATED,
      Event.SUBTITLE_TRACK_SWITCH,
      Event.SUBTITLE_TRACK_LOADED,
      Event.SUBTITLE_FRAG_PROCESSED,
      Event.LEVEL_UPDATED);

    this.fragmentTracker = fragmentTracker;
    this.config = hls.config;
    this.state = State.STOPPED;
    this.tracks = [];
    this.tracksBuffered = [];
    this.currentTrackId = -1;
    this.decrypter = new Decrypter(hls, hls.config);
    // lastAVStart stores the time in seconds for the start time of a level load
    this.lastAVStart = 0;
    this._onMediaSeeking = this.onMediaSeeking.bind(this);
  }

  startLoad () {
    this.stopLoad();
    this.state = State.IDLE;

    // Check if we already have a track with necessary details to load fragments
    const currentTrack = this.tracks[this.currentTrackId];
    if (currentTrack && currentTrack.details) {
      this.setInterval(TICK_INTERVAL);
      this.tick();
    }
  }

  onSubtitleFragProcessed (data) {
    const { frag, success } = data;
    this.fragPrevious = frag;
    this.state = State.IDLE;
    if (!success) {
      return;
    }

    const buffered = this.tracksBuffered[this.currentTrackId];
    if (!buffered) {
      return;
    }

    // Create/update a buffered array matching the interface used by BufferHelper.bufferedInfo
    // so we can re-use the logic used to detect how much have been buffered
    let timeRange;
    const fragStart = frag.start;
    for (let i = 0; i < buffered.length; i++) {
      if (fragStart >= buffered[i].start && fragStart <= buffered[i].end) {
        timeRange = buffered[i];
        break;
      }
    }

    const fragEnd = frag.start + frag.duration;
    if (timeRange) {
      timeRange.end = fragEnd;
    } else {
      timeRange = {
        start: fragStart,
        end: fragEnd
      };
      buffered.push(timeRange);
    }
  }

  onMediaAttached ({ media }) {
    this.media = media;
    media.addEventListener('seeking', this._onMediaSeeking);
    this.state = State.IDLE;
  }

  onMediaDetaching () {
    if (!this.media) {
      return;
    }
    this.media.removeEventListener('seeking', this._onMediaSeeking);
    this.fragmentTracker.removeAllFragments();
    this.currentTrackId = -1;
    this.tracks.forEach((track) => {
      this.tracksBuffered[track.id] = [];
    });
    this.media = null;
    this.state = State.STOPPED;
  }

  // If something goes wrong, proceed to next frag, if we were processing one.
  onError (data) {
    let frag = data.frag;
    // don't handle error not related to subtitle fragment
    if (!frag || frag.type !== 'subtitle') {
      return;
    }

    if (this.fragCurrent && this.fragCurrent.loader) {
      this.fragCurrent.loader.abort();
    }

    this.state = State.IDLE;
  }

  // Got all new subtitle tracks.
  onSubtitleTracksUpdated (data) {
    logger.log('subtitle tracks updated');
    this.tracksBuffered = [];
    this.tracks = data.subtitleTracks;
    this.tracks.forEach((track) => {
      this.tracksBuffered[track.id] = [];
    });
  }

  onSubtitleTrackSwitch (data) {
    this.currentTrackId = data.id;

    if (!this.tracks || !this.tracks.length || this.currentTrackId === -1) {
      this.clearInterval();
      return;
    }

    // Check if track has the necessary details to load fragments
    const currentTrack = this.tracks[this.currentTrackId];
    if (currentTrack && currentTrack.details) {
      this.setInterval(TICK_INTERVAL);
    }
  }

  // Got a new set of subtitle fragments.
  onSubtitleTrackLoaded (data) {
    const { id, details } = data;
    const { currentTrackId, tracks } = this;
    const currentTrack = tracks[currentTrackId];
    if (id >= tracks.length || id !== currentTrackId || !currentTrack) {
      return;
    }

    if (details.live) {
      mergeSubtitlePlaylists(currentTrack.details, details, this.lastAVStart);
    }
    currentTrack.details = details;
    this.setInterval(TICK_INTERVAL);
  }

  onKeyLoaded () {
    if (this.state === State.KEY_LOADING) {
      this.state = State.IDLE;
    }
  }

  onFragLoaded (data) {
    const fragCurrent = this.fragCurrent;
    const decryptData = data.frag.decryptdata;
    const fragLoaded = data.frag;
    const hls = this.hls;

    if (this.state === State.FRAG_LOADING &&
        fragCurrent &&
        data.frag.type === 'subtitle' &&
        fragCurrent.sn === data.frag.sn) {
      // check to see if the payload needs to be decrypted
      if (data.payload.byteLength > 0 && (decryptData && decryptData.key && decryptData.method === 'AES-128')) {
        let startTime = performance.now();

        // decrypt the subtitles
        this.decrypter.decrypt(data.payload, decryptData.key.buffer, decryptData.iv.buffer, function (decryptedData) {
          let endTime = performance.now();
          hls.trigger(Event.FRAG_DECRYPTED, { frag: fragLoaded, payload: decryptedData, stats: { tstart: startTime, tdecrypt: endTime } });
        });
      }
    }
  }

  onLevelUpdated ({ details }) {
    const frags = details.fragments;
    this.lastAVStart = frags.length ? frags[0].start : 0;
  }

  doTick () {
    if (!this.media) {
      this.state = State.IDLE;
      return;
    }

    switch (this.state) {
    case State.IDLE: {
      const { config, currentTrackId, fragmentTracker, media, tracks } = this;
      if (!tracks || !tracks[currentTrackId] || !tracks[currentTrackId].details) {
        break;
      }

      const { maxBufferHole, maxFragLookUpTolerance } = config;
      const maxConfigBuffer = Math.min(config.maxBufferLength, config.maxMaxBufferLength);
      const bufferedInfo = BufferHelper.bufferedInfo(this._getBuffered(), media.currentTime, maxBufferHole);
      const { end: bufferEnd, len: bufferLen } = bufferedInfo;

      const trackDetails = tracks[currentTrackId].details;
      const fragments = trackDetails.fragments;
      const fragLen = fragments.length;
      const end = fragments[fragLen - 1].start + fragments[fragLen - 1].duration;

      if (bufferLen > maxConfigBuffer) {
        return;
      }

      let foundFrag;
      const fragPrevious = this.fragPrevious;
      if (bufferEnd < end) {
        if (fragPrevious && trackDetails.hasProgramDateTime) {
          foundFrag = findFragmentByPDT(fragments, fragPrevious.endProgramDateTime, maxFragLookUpTolerance);
        }
        if (!foundFrag) {
          foundFrag = findFragmentByPTS(fragPrevious, fragments, bufferEnd, maxFragLookUpTolerance);
        }
      } else {
        foundFrag = fragments[fragLen - 1];
      }

      if (foundFrag && foundFrag.encrypted) {
        logger.log(`Loading key for ${foundFrag.sn}`);
        this.state = State.KEY_LOADING;
        this.hls.trigger(Event.KEY_LOADING, { frag: foundFrag });
      } else if (foundFrag && fragmentTracker.getState(foundFrag) === FragmentState.NOT_LOADED) {
        // only load if fragment is not loaded
        this.fragCurrent = foundFrag;
        this.state = State.FRAG_LOADING;
        this.hls.trigger(Event.FRAG_LOADING, { frag: foundFrag });
      }
    }
    }
  }

  stopLoad () {
    this.lastAVStart = 0;
    this.fragPrevious = null;
    super.stopLoad();
  }

  _getBuffered () {
    return this.tracksBuffered[this.currentTrackId] || [];
  }

  onMediaSeeking () {
    if (this.fragCurrent) {
      const currentTime = this.media ? this.media.currentTime : null;
      const tolerance = this.config.maxFragLookUpTolerance;
      const fragStartOffset = this.fragCurrent.start - tolerance;
      const fragEndOffset = this.fragCurrent.start + this.fragCurrent.duration + tolerance;

      // check if position will be out of currently loaded frag range after seeking : if out, cancel frag load, if in, don't do anything
      if (currentTime < fragStartOffset || currentTime > fragEndOffset) {
        if (this.fragCurrent.loader) {
          this.fragCurrent.loader.abort();
        }

        this.fragmentTracker.removeFragment(this.fragCurrent);
        this.fragCurrent = null;
        this.fragPrevious = null;

        // switch to IDLE state to load new fragment
        this.state = State.IDLE;

        // speed up things
        this.tick();
      }
    }
  }
}
