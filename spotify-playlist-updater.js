'use strict';

var request = require('request');
var async = require('async');
var cheerio = require('cheerio');
var nconf = require('nconf');

var config = nconf
  .file('conf', 'config/config.json')
  .file('config/default.json')
  .get();

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

SpotifyPlaylistUpdater.prototype.requestPlaylistSize = function(accessToken, cb) {
  var options = {
    headers: {
      'Authorization': 'Bearer ' + accessToken
    },
    json: true
  };

  var url = config.spotifyApiUrl + 'users/' + config.userId + '/playlists/' + config.playlistId + '/tracks';
  request.get(url, options, function (error, response, body) {
    if (error || response.statusCode !== 200) {
      console.log(error || response);
      cb(error || response);
    } else {
      cb(null, body.total);
    }
  });
}

SpotifyPlaylistUpdater.prototype.requestCurrentTracks = function(accessToken, playlistSize, cb) {
  if (playlistSize > 0) {
    var numRequestsLeft = Math.floor(playlistSize / 100) + 1;
    var offsets = [];
    for (var i = 0; i < numRequestsLeft; i++) {
      offsets.push(i * 100)
    }

    async.mapSeries(offsets, function(offset, cb) {
      var options = {
        headers: {
          'Authorization': 'Bearer ' + accessToken
        },
        qs: {
          offset: offset
        },
        json: true
      };

      var url = config.spotifyApiUrl + 'users/' + config.userId + '/playlists/' + config.playlistId + '/tracks';
      request.get(url, options, function (error, response, body) {
        if (error || response.statusCode !== 200) {
          console.log(error || response);
          cb(error || response);
        } else {
          var newTracks = body.items.map(function(item) {
            return {
              id: item.track.id,
              name: item.track.name
            }
          });
          cb(null, newTracks);
        }
      });
    }, function(error, results) {
      if (error) {
        cb(error);
      } else {
        cb(null, [].concat.apply([], results));
      }
    });
  } else {
    cb(null, []);
  }
};

SpotifyPlaylistUpdater.prototype.requestSongList = function(trackNameSet, cb) {
  var url = 'http://www.thepeak.fm/BroadcastHistory.aspx';
  request.get(url, {}, function (error, response, body) {
    if (error || response.statusCode !== 200) {
      console.log(error || response);
      cb(error || response);
    } else {
      var songList = [];
      var $ = cheerio.load(body);
      $('.broadcast span').each(function() {
        var song = $(this).text().replace(/"/g, "").trim();

        var songObj = {
          name: song.split('-')[0].trim(),
          artist: song.split('-')[1].trim()
        }

        if (!trackNameSet[songObj.name.toLowerCase()]) {
          songList.push(songObj);
        }
      });
      cb(null, songList);
    }
  });
};

SpotifyPlaylistUpdater.prototype.searchForTracks = function(songList, trackIdSet, accessToken, cb) {
  async.mapSeries(songList, function(item, cb) {
    var options = {
      headers: {
        'Authorization': 'Bearer ' + accessToken
      },
      json: true,
      qs: {
        q: 'artist:' + item.artist + ' track:' + item.name,
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
            cb(null, song.uri);
          }
        }
      }
    });
  },
  function(err, results) {
    // remove tracks that are not found
    var uris = results.filter(function(value) {
      return value;
    });
    cb(null, uris);
  });
};

SpotifyPlaylistUpdater.prototype.addToPlaylist = function(uris, accessToken, cb) {
  if (uris.length > 0) {
    var splitUris = [];
    while (uris.length > 0) {
      splitUris.push(uris.splice(0, 100));
    }

    var url = config.spotifyApiUrl + 'users/' + config.userId + '/playlists/' + config.playlistId + '/tracks';
    async.eachSeries(splitUris, function(uriArray, cb) { 
      var options = {
        headers: {
          'Authorization': 'Bearer ' + accessToken
        },
        json: true,
        body: {
          uris: uriArray
        }
      };

      request.post(url, options, function (error, response, body) {
        if (error || response.statusCode !== 201) {
          console.log(error || response);
        } else {
          console.log(uriArray.length + ' songs added');
        }

        cb();
      });
    },
    function(err) {
      cb();
    });
  } else {
    console.log('0 songs added');
    cb();
  }
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
      _this.requestPlaylistSize(accessToken, cb);
    },
    function(playlistSize, cb) {
      _this.requestCurrentTracks(accessToken, playlistSize, cb);
    },
    function(tracks, cb) {
      for (var i = 0; i < tracks.length; i++) {
        trackIdSet[tracks[i].id] = tracks[i].id;
        trackNameSet[tracks[i].name.toLowerCase()] = tracks[i].name.toLowerCase();
      }

      if (newSongs) {
        cb(null, newSongs)
      } else {
        _this.requestSongList(trackNameSet, cb);
      }
    },
    function(songList, cb) {
      _this.searchForTracks(songList, trackIdSet, accessToken, cb);
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