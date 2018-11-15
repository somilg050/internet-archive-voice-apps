/**
 * Async Albums feeder
 * it fetches data on-demand
 *
 * pros:
 * - memory (user's state) efficient, because loads only needed songs
 * - could deal with very large of unlimited list of songs
 *
 * cons:
 * - could have delay on songs swapping
 * - could lack of information about real size of playlist
 *
 */

const _ = require('lodash');

const config = require('../../config');
const albumsProvider = require('../../provider/albums');
const { debug, warning, error } = require('../../utils/logger')('ia:feeder:albums-async');
const stripFileName = require('../../utils/strip-filename');

const orderStrategies = require('../orders');

const DefaultFeeder = require('./_default');

const defaultCursor = {
  current: {
    album: 0,
    song: 0,
  },

  total: {
    albums: 0,
    songs: 0,
  },
};

/**
 * name of feeder
 */
const feederName = stripFileName(__filename);

class AsyncAlbums extends DefaultFeeder {
  /**
   * Prefetch some songs from albums
   * and create playlist
   *
   * @param app
   * @param query
   * @param playlist
   * @returns {Promise}
   */
  build ({ app, query, playlist }) {
    debug('build async songs feeder');

    return this.fetchChunkOfSongs({ app, query, playlist })
      .then(({ songs, songsInFirstAlbum, totalNumOfAlbums }) => {
        // the only place where we modify state
        // so maybe we can put it out of this function?
        debug(`let's create playlist for songs`);
        songs = this.processNewSongsBeforeMoveToNext({ app, query, playlist }, songs);
        playlist.create(app, songs, {
          cursor: Object.assign({}, defaultCursor, {
            total: {
              songs: songsInFirstAlbum,
              albums: totalNumOfAlbums,
            },
          }),
        });
        return { total: totalNumOfAlbums };
      });
  }

  /**
   * Fetch chunk of songs
   *
   * @private
   * @param app
   * @param query
   * @param playlist
   * @returns {Promise.<T>}
   */
  fetchChunkOfSongs ({ app, query, playlist }) {
    const slots = query.getSlots(app);
    debug('we have slots:', slots);

    const feederConfig = this.getConfigForOrder(app, query);
    if (!feederConfig) {
      warning(`something wrong we don't have config of feeder`);
    }

    debug('config of feeder', feederConfig);

    const cursor = this.getCursor(app, playlist);
    let totalNumOfAlbums = 0;

    const orderStrategy = orderStrategies.getByName(
      query.getSlot(app, 'order')
    );

    return albumsProvider
      .fetchAlbumsByQuery(
        app,
        Object.assign(
          {},
          slots,
          orderStrategy.getPage({ app, cursor, feederConfig })
        )
      )
      .then((albums) => {
        if (albums === null) {
          warning(`we received none albums`);
          return;
        }
        debug(`get ${albums.items.length} albums`);
        debug(`in total we have ${albums.total} albums`);
        totalNumOfAlbums = albums.total;
        // TODO: but actually we should get random album (of few of them)
        // and then get few random songs from those albums
        return Promise.all(
          albums.items
            .map(
              album => albumsProvider
                .fetchAlbumDetails(app, album.identifier, {
                  retry: 3,
                  delay: 100,
                })
                .catch(error => {
                  warning(`we failed on fetching details about album:`, error);
                  return null;
                })
            )
        );
      })
      .then(albums => {
        // drop failed albums
        albums = albums.filter(album => album);

        if (!albums || albums.length === 0) {
          debug('we got none albums');
          return {
            songs: [],
            songsInFirstAlbum: 0,
            songsNumInLastAlbum: 0,
            totalNumOfAlbums: 0,
          };
        }

        const songsInFirstAlbum = albums[0].songs.length;
        const numOfSongsInLastAlbum = albums[albums.length - 1].songs.length;

        let songs = albums
          .map(this.processAlbumSongs)
          .reduce((allSongs, albumSongs) => {
            return allSongs.concat(albumSongs);
          }, []);

        if (songs.length === 0) {
          warning(`we received zero songs. It doesn't sound ok`);
          // let's try again
          return this.fetchChunkOfSongs({ app, query, playlist });
        }

        return {
          songs,
          songsInFirstAlbum,
          numOfSongsInLastAlbum,
          totalNumOfAlbums
        };
      })
      .catch(err => {
        error('We got an error:', err);
        return Promise.reject(err);
      });
  }

  /**
   * Process list of songs before move to the next song
   *
   * @param app
   * @param query
   * @param playlist
   * @param songs
   * @returns {*[]}
   */
  processNewSongsBeforeMoveToNext ({ app, query, playlist }, songs) {
    debug('process songs on moving to next');
    const cursor = this.getCursor(app, playlist);
    const feederConfig = this.getConfigForOrder(app, query);
    const orderStrategy = orderStrategies.getByName(
      query.getSlot(app, 'order')
    );

    debug(`we get ${songs.length} songs`);

    songs = orderStrategy.songsPostProcessing({ songs, cursor });

    // to chap few songs at the start because we've already fetched them
    // start from song we need
    songs = songs.slice(cursor.current.song);

    // get chunk of songs
    if (feederConfig.chunk.songs) {
      songs = songs.slice(0, feederConfig.chunk.songs);
      debug(`but only ${songs.length} in chunk left`);
    }

    return songs;
  }

  /**
   * Process list of songs before move to the previous song
   *
   * @param songs
   * @param app
   * @param query
   * @param playlist
   * @returns {*[]}
   */
  processNewSongsBeforeMoveToPrevious ({ app, query, playlist }, songs) {
    debug('process songs on moving to previous');
    const cursor = this.getCursor(app, playlist);
    const feederConfig = this.getConfigForOrder(app, query);
    const orderStrategy = orderStrategies.getByName(
      query.getSlot(app, 'order')
    );

    debug(`we get ${songs.length} songs`);

    songs = orderStrategy.songsPostProcessing({ songs, cursor });

    // to chap few songs at the end because we've already fetched them
    // start from song we need
    songs = songs.slice(0, cursor.current.song + 1);

    debug(`left ${songs.length} songs after dropping after ${cursor.current.song}`);

    // get chunk of songs
    if (feederConfig.chunk.songs) {
      songs = _.takeRight(songs, feederConfig.chunk.songs);
      // songs = songs.slice(0, feederConfig.chunk.songs);`
      debug(`but only ${songs.length} in chunk left`);
    }

    return songs;
  }

  /**
   * Get configuration based on arguments
   *
   * @private
   * @param app
   * @param query
   * @returns {*}
   */
  getConfigForOrder (app, query) {
    const order = query.getSlot(app, 'order');
    const available = config.feeders[feederName];
    return available[order] || available.defaults;
  }

  /**
   * Get cursor of playlist in sources
   *
   * @private
   * @param app
   * @param playlist
   * @returns {current: {album: number, song: number}, total: {albums: number, songs: number}}
   */
  getCursor (app, playlist) {
    return _.at(playlist.getExtra(app), 'cursor')[0] || defaultCursor;
  }

  /**
   * Do we have next item?
   *
   * @param app
   * @param slots
   * @param playlist
   * @returns {boolean}
   */
  hasNext ({ app, query, playlist }) {
    if (playlist.isLoop(app)) {
      return true;
    }

    const orderStrategy = orderStrategies.getByName(
      query.getSlot(app, 'order')
    );
    return orderStrategy.hasNext({ app, query, playlist });
  }

  /**
   * Do we have next item?
   *
   * @param app
   * @param slots
   * @param playlist
   * @returns {boolean}
   */
  hasPrevious ({ app, query, playlist }) {
    if (playlist.isLoop(app)) {
      return true;
    }

    const orderStrategy = orderStrategies.getByName(
      query.getSlot(app, 'order')
    );
    return orderStrategy.hasPrevious({ app, query, playlist });
  }

  /**
   * Move to the next song
   *
   * @param app
   * @param query
   * @param playlist
   *
   * @returns {Promise.<T>}
   */
  next ({ app, query, playlist }) {
    debug('move to the next song');
    const orderStrategy = orderStrategies.getByName(
      query.getSlot(app, 'order')
    );

    orderStrategy.moveSourceCursorToTheNextPosition({ app, query, playlist });

    return Promise.resolve()
      .then(() => {
        // check whether we need to fetch new chunk
        if (playlist.hasNextSong(app)) {
          debug('we have next song so just move cursor without fetching new data');
        } else {
          debug(`we don't have next song in playlist so we'll fetch new chunk of songs`);
          return this
            .fetchChunkOfSongs({ app, query, playlist })
            .then(({ songs, songsInFirstAlbum }) => {
              songs = this.processNewSongsBeforeMoveToNext({ app, query, playlist }, songs);

              // merge new songs
              let items = playlist.getItems(app).concat(songs);

              // but we shouldn't exceed available size of chunk
              const feederConfig = this.getConfigForOrder(app, query);
              if (items.length > feederConfig.chunk.songs) {
                const shift = items.length - feederConfig.chunk.songs;
                debug(`drop ${shift} old song(s)`);
                items = items.slice(shift);
                playlist.shift(app, -shift);
              }
              playlist.updateItems(app, items);

              orderStrategy.updateCursorTotal({
                app,
                playlist,
                songsInFirstAlbum,
              });
            });
        }
      })
      .then(() => {
        playlist.next(app);
      });
  }

  /**
   * Move to the previous song
   *
   * @param app
   * @param query
   * @param playlist
   *
   * @returns {Promise.<T>}
   */
  previous ({ app, query, playlist }) {
    debug('move to the previous song');
    const orderStrategy = orderStrategies.getByName(
      query.getSlot(app, 'order')
    );

    orderStrategy.moveSourceCursorToThePreviousPosition({ app, query, playlist });

    return Promise.resolve()
      .then(() => {
        // check whether we need to fetch new chunk
        if (playlist.hasPreviousSong(app)) {
          debug('we have previous song so just move cursor without fetching new data');
        } else {
          debug(`we don't have previous song in playlist so we'll fetch new chunk of songs`);
          return this
            .fetchChunkOfSongs({ app, query, playlist })
            .then(({ songs, numOfSongsInLastAlbum }) => {
              orderStrategy.clampCursorSongPosition({ app, playlist }, numOfSongsInLastAlbum - 1);

              songs = this.processNewSongsBeforeMoveToPrevious({ app, query, playlist }, songs);

              // but we shouldn't exceed available size of chunk
              const feederConfig = this.getConfigForOrder(app, query);

              // get last tail of songs
              songs = _.takeRight(songs, feederConfig.chunk.songs);

              // merge new songs
              let items = songs.concat(playlist.getItems(app));

              if (items.length > feederConfig.chunk.songs) {
                debug(`drop ${items.length - feederConfig.chunk.songs} old song(s)`);
                items = items.slice(0, feederConfig.chunk.songs);
              }
              // because we append new songs at the playlist start
              // we should shift its current position to the size of appended songs
              playlist.shift(app, songs.length);
              playlist.updateItems(app, items);

              orderStrategy.updateCursorTotal({
                app,
                playlist,
                numOfSongsInLastAlbum,
              });
            });
        }
      })
      .then(() => {
        playlist.previous(app);
      });
  }
}

module.exports = new AsyncAlbums();
