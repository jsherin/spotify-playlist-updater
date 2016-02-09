'use strict';

var request = require('request');
var async = require('async');
var cheerio = require('cheerio');
var nconf = require('nconf');

var config = nconf
  .file('conf', 'config/config.json')
  .file('config/default.json')
  .get();

var MAX_RESULTS = 100;

function SpotifyPlaylistUpdater() {}

SpotifyPlaylistUpdater.prototype.requestAccessToken = function(cb) {
  var options = {
    form: {
      grant_type: 'refresh_token', 
      refresh_token: config.refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret
    }
  };

  request.post(config.spotifyAuthApiUrl, options, function (error, response, body) {
    if (error || response.statusCode !== 200) {
      console.log(error || response);
      cb(error || response);
    } else {
      var token = JSON.parse(body);
      cb(null, token.access_token);
    }
  });
};

SpotifyPlaylistUpdater.prototype.requestCurrentTracks = function(accessToken, cb) {
  var currentTracks = [];
  var tracksToRemove = [];
  var numTracks = 0;
  var offset = 0;

  var url = config.spotifyApiUrl + 'users/' + config.userId + '/playlists/' + config.playlistId + '/tracks';
  async.doWhilst(function(cb) {
    var options = {
      headers: {
        'Authorization': 'Bearer ' + accessToken
      },
      qs: {
        offset: offset
      },
      json: true
    };

    request.get(url, options, function (error, response, body) {
      if (error || response.statusCode !== 200) {
        console.log(error || response);
        cb(error || response);
      } else {
        numTracks = body.total;
        body.items.forEach(function(item) {
          var toRemove = false;
          if (parseInt(config.removeAfterAddedMs) >= 0 && 
              (new Date().getTime() - config.removeAfterAddedMs > new Date(item.added_at).getTime())) {
            tracksToRemove.push( { uri: item.track.uri }); 
          } else {
            currentTracks.push({
              id: item.track.id,
              name: item.track.name,
            });
          }
        });
        offset += MAX_RESULTS;
        cb();
      }
    });
  }, function() {
    return numTracks - currentTracks.length - tracksToRemove.length > 0
  }, function(error) {
    if (error) {
      cb(error);
    } else {
      cb(null, currentTracks, tracksToRemove);
    }
  });
};

SpotifyPlaylistUpdater.prototype.removeOldTracksFromPlaylist = function(accessToken, tracksToRemove, cb) {
  var numRemoved = 0;

  var url = config.spotifyApiUrl + 'users/' + config.userId + '/playlists/' + config.playlistId + '/tracks';
  async.whilst(function() {
    return tracksToRemove.length > 0;
  }, function(cb) {
    var urisToRemove = tracksToRemove.splice(0, MAX_RESULTS);

    var options = {
      headers: {
        'Authorization': 'Bearer ' + accessToken
      },
      json: true,
      body: {
        tracks: urisToRemove
      }
    };

    request.del(url, options, function (error, response, body) {
      if (error || response.statusCode !== 200) {
        console.log(error || response);
      } else {
        numRemoved += urisToRemove.length;
      }

      cb();
    });
  },
  function(err) {
    console.log(numRemoved + ' songs removed');
    cb();
  });
};

SpotifyPlaylistUpdater.prototype.requestThePeakSongList = function(trackNameSet, cb) {
  var url = 'http://www.thepeak.fm/BroadcastHistory.aspx';
  request.get(url, {}, function (error, response, body) {
    var songList = [];

    if (error || response.statusCode !== 200) {
      console.log(error || response);
    } else {
      var $ = cheerio.load(body);
      $('.broadcast span').each(function() {
        var song = $(this).text().replace(/"/g, "").trim();

        var songObj = {
          name: song.split(' - ')[0].trim(),
          artist: song.split(' - ')[1].trim()
        }

        if (!trackNameSet[songObj.name.toLowerCase()]) {
          trackNameSet[songObj.name.toLowerCase()] = songObj.name.toLowerCase();
          songList.push(songObj);
        }
      });
    }

    cb(null, songList);
  });
};

SpotifyPlaylistUpdater.prototype.requestTheEndSongList = function(trackNameSet, cb) {
  var until = new Date().toISOString();
  var since = new Date(new Date().getTime() - 86400000).toISOString();
  var url = 'http://kndd.tunegenie.com/api/v1/brand/nowplaying/?apiid=entercom&since=' + since + '&until=' + until;
  request.get(url, { json: true }, function (error, response, body) {
    var songList = [];

    if (error || response.statusCode !== 200) {
      console.log(error || response);
    } else {
      body.response.forEach(function(item) {
        if (!trackNameSet[item.song.toLowerCase()]) {
          trackNameSet[item.song.toLowerCase()] = item.song.toLowerCase();
          songList.push({
            name: item.song,
            artist: item.artist
          });
        }
      });
    }

    cb(null, songList);
  });
};

SpotifyPlaylistUpdater.prototype.requestSongList = function(trackNameSet, cb) {
  var _this = this;

  async.mapSeries(config.sources, function (source, cb) {
    switch(source) {
      case 'thepeak':
        _this.requestThePeakSongList(trackNameSet, cb);
        break;
      case 'theend':
        _this.requestTheEndSongList(trackNameSet, cb);
        break;
      default:
        cb([]);
    }
  },
  function(err, songLists){
    cb(null, [].concat.apply([], songLists))
  });
};

SpotifyPlaylistUpdater.prototype.sanitizeStringForSearch = function(s) {
  s = s.replace(/\(.*/g, '');
  s = s.replace(/\/.*/g, '');
  s = s.replace(/(ftr).*/g, '');
  s = s.replace(/(feat).*/g, '');
  s = s.replace(/(FTR).*/g, '');
  s = s.replace(/(FEAT).*/g, '');
  s = s.replace(/[&+]/g, '');

  return s.toLowerCase();
};

SpotifyPlaylistUpdater.prototype.searchForTracks = function(songList, trackIdSet, accessToken, cb) {
  var _this = this;
  async.mapSeries(songList, function(item, cb) {
    var options = {
      headers: {
        'Authorization': 'Bearer ' + accessToken
      },
      json: true,
      qs: {
        q: 'artist:' + _this.sanitizeStringForSearch(item.artist) + ' track:' + _this.sanitizeStringForSearch(item.name),
        type: 'track',
        market: config.market,
        limit: 1
      }
    };

    request.get(config.spotifyApiUrl + 'search', options, function (error, response, body) {
      if (error || response.statusCode !== 200) {
        console.log(error || response);
        cb();
      } else {
        if (body.tracks.total === 0) {
          cb();
        } else {
          var song = body.tracks.items[0];
          if (trackIdSet[song.id]) {
            cb();
          } else {
            trackIdSet[song.id] = song.id;
            cb(null, song);
          }
        }
      }
    });
  },
  function(err, results) {
    // remove tracks that are not found
    var songs = results.filter(function(song) {
      return song;
    });
    cb(null, songs);
  });
};

SpotifyPlaylistUpdater.prototype.filterByDate = function(songs, accessToken, cb) {
  var _this = this;
  async.mapSeries(songs, function(song, cb) {
    if (config.releasedAfter && song.album) {
      var options = {
        headers: {
          'Authorization': 'Bearer ' + accessToken
        },
        json: true
      };

      request.get(config.spotifyApiUrl + 'albums/' + song.album.id, options, function (error, response, body) {
        if (error || response.statusCode !== 200) {
          console.log(error || response);
          cb();
        } else {
          if (!body.release_date ||
              (new Date(body.release_date).getTime() > new Date(config.releasedAfter).getTime())) {
            cb(null, song.uri);
          } else {
            cb();
          }
        }
      });
    } else {
      cb(null, song.uri);
    }
  },
  function(err, results) {
    var uris = results.filter(function(uri) {
      return uri;
    });
    cb(null, uris);
  });
};

SpotifyPlaylistUpdater.prototype.addToPlaylist = function(uris, accessToken, cb) {
  var numAdded = 0;

  var url = config.spotifyApiUrl + 'users/' + config.userId + '/playlists/' + config.playlistId + '/tracks';
  async.whilst(function() {
    return uris.length > 0;
  }, function(cb) {
    var urisToAdd = uris.splice(0, MAX_RESULTS);

    var options = {
      headers: {
        'Authorization': 'Bearer ' + accessToken
      },
      json: true,
      body: {
        uris: urisToAdd
      }
    };

    request.post(url, options, function (error, response, body) {
      if (error || response.statusCode !== 201) {
        console.log(error || response);
      } else {
        numAdded += urisToAdd.length;
      }

      cb();
    });
  },
  function(err) {
    console.log(numAdded + ' songs added');
    cb();
  });
};

SpotifyPlaylistUpdater.prototype.updatePlaylist = function(newSongs, cb) {
  var _this = this;
  var accessToken;
  var trackIdSet = {};
  var trackNameSet = {};
  
  async.waterfall([
    function(cb) {
      _this.requestAccessToken(cb);
    },
    function(token, cb) {
      accessToken = token;
      _this.requestCurrentTracks(accessToken, cb);
    },
    function(tracks, tracksToRemove, cb) {
      for (var i = 0; i < tracks.length; i++) {
        trackIdSet[tracks[i].id] = tracks[i].id;
        trackNameSet[tracks[i].name.toLowerCase()] = tracks[i].name.toLowerCase();
      }

      _this.removeOldTracksFromPlaylist(accessToken, tracksToRemove, cb);
    },
    function(cb) {
      if (newSongs) {
        cb(null, newSongs)
      } else {
        _this.requestSongList(trackNameSet, cb);
      }
    },
    function(songList, cb) {
      _this.searchForTracks(songList, trackIdSet, accessToken, cb);
    },
    function(songs, cb) {
      _this.filterByDate(songs, accessToken, cb);
    },
    function(uris, cb) {
      _this.addToPlaylist(uris, accessToken, cb);
    }
  ], function (err, result) {
    if (cb) {
      cb();
    }
  });
}

var handler = function(event, context) {
  new SpotifyPlaylistUpdater().updatePlaylist(event.newSongs, function() {
    context.succeed();
  });
};

module.exports = {
  SpotifyPlaylistUpdater: SpotifyPlaylistUpdater,
  handler: handler
};