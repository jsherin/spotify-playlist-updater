'use strict';

var request = require('request');
var should = require('chai').should();
var assert = require('chai').assert;
var sinon = require('sinon');
var SpotifyPlaylistUpdater = require('../spotify-playlist-updater').SpotifyPlaylistUpdater;
var Handler = require('../spotify-playlist-updater').handler;

describe('handler', function() {
  it('should request data', function (done) {
    this.timeout(100000);
	  new Handler(
      {},
      {
        succeed : function () {
          done();
        }
      }
    );
  });
});