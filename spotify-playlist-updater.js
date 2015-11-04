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
        var newTracks = body.items.map(function(item) {
          return {
            id: item.track.id,
            name: item.track.name
          }
        });
        currentTracks = currentTracks.concat(newTracks);
        offset += MAX_RESULTS;
        cb();
      }
    });
  }, function() {
    return numTracks - currentTracks.length > 0
  }, function(error) {
    if (error) {
      cb(error);
    } else {
      cb(null, currentTracks);
    }
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
          name: song.split('-')[0].trim(),
          artist: song.split('-')[1].trim()
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
  async.series([
    function(cb){
      _this.requestThePeakSongList(trackNameSet, cb);
    },
    function(cb){
      _this.requestTheEndSongList(trackNameSet, cb)
    }
  ],
  function(err, songLists){
    cb(null, [].concat.apply([], songLists))
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