(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.LampaUnwatchedSeries = api;
    if (root.Lampa) api.init(root.Lampa);
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    var PLUGIN_ID = 'unwatched-series';
    var COMPLETION_PERCENT = 90;
    var RECENT_DAYS = 14;
    var TRACKED_TYPES = ['like', 'continued', 'look'];
    var initialized = false;

    function isSeries(card) {
        return Boolean(card && card.id !== undefined && card.original_name);
    }

    function cardKey(card) {
        return String(card.source || 'tmdb') + ':' + String(card.id);
    }

    function clone(card) {
        var copy = {};
        Object.keys(card || {}).forEach(function (key) { copy[key] = card[key]; });
        return copy;
    }

    function trackedCards(favorite) {
        var seen = {};
        var cards = [];

        TRACKED_TYPES.forEach(function (type) {
            (favorite.get({ type: type }) || []).forEach(function (card) {
                var key;
                if (!isSeries(card)) return;
                key = cardKey(card);
                if (!seen[key]) {
                    seen[key] = true;
                    cards.push(card);
                }
            });
        });

        return cards;
    }

    function timestamp(date) {
        return date ? new Date(String(date) + 'T23:59:59').getTime() : NaN;
    }

    function usableEpisode(episode, now) {
        var airTime = timestamp(episode && episode.air_date);
        return Boolean(episode && Number(episode.season_number) > 0 &&
            Number(episode.episode_number) > 0 && !Number.isNaN(airTime) && airTime <= now);
    }

    function compareEpisodes(left, right) {
        return Number(left.season_number) - Number(right.season_number) ||
            Number(left.episode_number) - Number(right.episode_number);
    }

    function episodeCode(episode) {
        return 'S' + String(episode.season_number).padStart(2, '0') +
            'E' + String(episode.episode_number).padStart(2, '0');
    }

    function buildModel(cards, episodesByCard, progressFor, now) {
        var recentStart = now - RECENT_DAYS * 86400000;
        var next = [];
        var recent = [];

        cards.forEach(function (card) {
            var first;
            var episodes = (episodesByCard[cardKey(card)] || [])
                .filter(function (episode) { return usableEpisode(episode, now); })
                .sort(compareEpisodes);

            episodes.forEach(function (episode) {
                var progress = Number(progressFor(card, episode)) || 0;
                var item;
                if (progress >= COMPLETION_PERCENT) return;
                item = { card: card, episode: episode, progress: progress, airTime: timestamp(episode.air_date) };
                if (!first) first = item;
                if (item.airTime >= recentStart) recent.push(item);
            });

            if (first) next.push(first);
        });

        next.sort(function (left, right) {
            var leftPartial = left.progress > 0 ? 1 : 0;
            var rightPartial = right.progress > 0 ? 1 : 0;
            return rightPartial - leftPartial || left.airTime - right.airTime ||
                String(left.card.name || left.card.title).localeCompare(String(right.card.name || right.card.title));
        });
        recent.sort(function (left, right) { return right.airTime - left.airTime || compareEpisodes(left.episode, right.episode); });

        return { next: next, recent: recent, tracked: cards.slice() };
    }

    function loadEpisodes(timeTable, cards) {
        var episodesByCard = {};
        return Promise.all(cards.map(function (card) {
            return new Promise(function (resolve) {
                try {
                    timeTable.get(card, function (episodes) {
                        episodesByCard[cardKey(card)] = Array.isArray(episodes) ? episodes : [];
                        resolve();
                    });
                }
                catch (error) {
                    episodesByCard[cardKey(card)] = [];
                    resolve();
                }
            });
        })).then(function () { return episodesByCard; });
    }

    function canUseCub(lampa) {
        return Boolean(lampa && lampa.Favorite && lampa.TimeTable && lampa.Timeline &&
            lampa.Account && lampa.Account.Permit && lampa.Account.Permit.sync);
    }

    function modelForLampa(lampa) {
        var cards;
        if (!canUseCub(lampa)) return Promise.resolve({ next: [], recent: [], tracked: [] });
        cards = trackedCards(lampa.Favorite);
        return loadEpisodes(lampa.TimeTable, cards).then(function (episodesByCard) {
            return buildModel(cards, episodesByCard, function (card, episode) {
                return lampa.Timeline.watchedEpisode(card, episode.season_number, episode.episode_number);
            }, Date.now());
        });
    }

    function title(lampa, key, fallback) {
        return lampa.Lang && lampa.Lang.translate ? lampa.Lang.translate(key) : fallback;
    }

    function displayEpisode(item) {
        var card = clone(item.card);
        var name = card.name || card.title || card.original_name || card.original_title;
        card.name = name + ' — ' + episodeCode(item.episode);
        card.unwatched_series = { season: Number(item.episode.season_number), episode: Number(item.episode.episode_number) };
        return card;
    }

    function addRow(lampa, name, labelKey, fallback, select, render) {
        lampa.ContentRows.add({
            name: PLUGIN_ID + '-' + name,
            title: title(lampa, labelKey, fallback),
            index: 0,
            screen: ['main'],
            call: function () {
                return function (done) {
                    modelForLampa(lampa).then(function (model) {
                        done({ title: title(lampa, labelKey, fallback), results: select(model).map(render) });
                    }).catch(function () {
                        done({ title: title(lampa, labelKey, fallback), results: [] });
                    });
                };
            }
        });
    }

    function register(lampa) {
        if (initialized || !lampa || !lampa.ContentRows) return false;
        initialized = true;

        if (lampa.Lang && lampa.Lang.add) {
            lampa.Lang.add({
                unwatched_series_next: { ru: 'Следующие серии', en: 'Next episodes' },
                unwatched_series_recent: { ru: 'Вышли недавно', en: 'Recently released' },
                unwatched_series_tracking: { ru: 'Смотрю', en: 'Watching' }
            });
        }

        addRow(lampa, 'next', 'unwatched_series_next', 'Next episodes', function (model) { return model.next; }, displayEpisode);
        addRow(lampa, 'recent', 'unwatched_series_recent', 'Recently released', function (model) { return model.recent; }, displayEpisode);
        addRow(lampa, 'tracking', 'unwatched_series_tracking', 'Watching', function (model) { return model.tracked; }, clone);
        return true;
    }

    function init(lampa) {
        if (!lampa) return false;
        if (register(lampa)) return true;
        if (lampa.Listener && lampa.Listener.follow) {
            lampa.Listener.follow('app', function (event) {
                if (event.type === 'ready') register(lampa);
            });
        }
        return false;
    }

    return {
        COMPLETION_PERCENT: COMPLETION_PERCENT,
        RECENT_DAYS: RECENT_DAYS,
        TRACKED_TYPES: TRACKED_TYPES.slice(),
        trackedCards: trackedCards,
        buildModel: buildModel,
        displayEpisode: displayEpisode,
        init: init
    };
});
