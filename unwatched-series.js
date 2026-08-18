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
    // The CUB book type is Избранное; like is only Нравится.
    var TRACKED_TYPES = ['book', 'like', 'continued', 'look'];
    var FINISHED_TYPES = ['viewed', 'thrown'];
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
        var finished = {};
        var cards = [];

        FINISHED_TYPES.forEach(function (type) {
            (favorite.get({ type: type }) || []).forEach(function (card) {
                if (card && card.id !== undefined) finished[String(card.id)] = true;
            });
        });

        TRACKED_TYPES.forEach(function (type) {
            (favorite.get({ type: type }) || []).forEach(function (card) {
                var key;
                if (!isSeries(card) || finished[String(card.id)]) return;
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

    function episodeProgress(lampa, card, episode) {
        var names = [];
        var progress = 0;

        [card.original_name, card.original_title, card.name, card.title].forEach(function (name) {
            if (name && names.indexOf(name) === -1) names.push(name);
        });

        names.forEach(function (name) {
            var lookupCard = clone(card);
            var value;

            lookupCard.original_name = name;
            lookupCard.original_title = name;
            value = lampa.Timeline.watchedEpisode(lookupCard, episode.season_number, episode.episode_number);
            value = value === true ? 100 : (Number(value) || 0);
            progress = Math.max(progress, value);
        });

        return progress;
    }

    function episodeCode(episode) {
        return 'S' + String(episode.season_number).padStart(2, '0') +
            'E' + String(episode.episode_number).padStart(2, '0');
    }

    function buildModel(cards, episodesByCard, progressFor, now) {
        var recentStart = now - RECENT_DAYS * 86400000;
        var next = [];
        var recent = [];
        var tracked = [];

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

            if (first) {
                next.push(first);
                tracked.push(card);
            }
        });

        next.sort(function (left, right) {
            var leftPartial = left.progress > 0 ? 1 : 0;
            var rightPartial = right.progress > 0 ? 1 : 0;
            return rightPartial - leftPartial || left.airTime - right.airTime ||
                String(left.card.name || left.card.title).localeCompare(String(right.card.name || right.card.title));
        });
        recent.sort(function (left, right) { return right.airTime - left.airTime || compareEpisodes(left.episode, right.episode); });

        return { next: next, recent: recent, tracked: tracked };
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
                return episodeProgress(lampa, card, episode);
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

    function libraryRows(lampa, model) {
        return [
            { title: title(lampa, 'unwatched_series_next', 'Next episodes'), results: model.next.map(displayEpisode), nomore: true },
            { title: title(lampa, 'unwatched_series_recent', 'Recently released'), results: model.recent.map(displayEpisode), nomore: true },
            { title: title(lampa, 'unwatched_series_tracking', 'Watching'), results: model.tracked.map(clone), nomore: true }
        ].filter(function (row) { return row.results.length; });
    }

    function libraryComponent(lampa) {
        return function (object) {
            var component;

            if (lampa.Maker && lampa.Maker.make) {
                component = lampa.Maker.make('Main', object);
                component.use({
                    onCreate: function () {
                        var page = this;
                        modelForLampa(lampa).then(function (model) {
                            page.build(libraryRows(lampa, model));
                        }).catch(function () {
                            page.build([]);
                        });
                    },
                    onInstance: function (line) {
                        line.use({
                            onInstance: function (card, data) {
                                card.use({
                                    onlyEnter: function () {
                                        lampa.Activity.push({
                                            url: data.url,
                                            component: 'full',
                                            id: data.id,
                                            method: data.name ? 'tv' : 'movie',
                                            card: data,
                                            source: data.source || 'tmdb'
                                        });
                                    }
                                });
                            }
                        });
                    }
                });

                return component;
            }

            component = new lampa.Interaction.Main(object);

            component.create = function () {
                modelForLampa(lampa).then(function (model) {
                    component.build(libraryRows(lampa, model));
                }).catch(function () {
                    component.build([]);
                });
            };

            return component;
        };
    }

    function canOpenLibraryPage(lampa) {
        return Boolean(lampa.Component && ((lampa.Maker && lampa.Maker.make) ||
            (lampa.Interaction && lampa.Interaction.Main)));
    }

    function openFallback(lampa) {
        modelForLampa(lampa).then(function (model) {
            var items = [];

            libraryRows(lampa, model).forEach(function (row) {
                row.results.forEach(function (card) {
                    items.push({
                        title: row.title + ' — ' + (card.name || card.title || card.original_name),
                        card: card
                    });
                });
            });

            if (!items.length) {
                if (lampa.Noty && lampa.Noty.show) lampa.Noty.show('Нет непросмотренных серий');
                return;
            }

            lampa.Select.show({
                title: title(lampa, 'unwatched_series_title', 'Unwatched series'),
                items: items,
                onSelect: function (item) {
                    var card = item.card;
                    lampa.Activity.push({
                        url: card.url,
                        component: 'full',
                        id: card.id,
                        method: card.name ? 'tv' : 'movie',
                        card: card,
                        source: card.source || 'tmdb'
                    });
                }
            });
        });
    }

    function openLibrary(lampa) {
        if (!canOpenLibraryPage(lampa)) {
            openFallback(lampa);
            return;
        }
        lampa.Activity.push({
            url: PLUGIN_ID,
            component: PLUGIN_ID,
            title: title(lampa, 'unwatched_series_title', 'Unwatched series'),
            page: 1,
            source: 'cub'
        });
    }

    function register(lampa) {
        if (initialized || !lampa || !lampa.Menu || !lampa.Activity) return false;

        try {
            if (lampa.Lang && lampa.Lang.add) {
                lampa.Lang.add({
                    unwatched_series_next: { ru: 'Следующие серии', en: 'Next episodes' },
                    unwatched_series_recent: { ru: 'Вышли недавно', en: 'Recently released' },
                    unwatched_series_tracking: { ru: 'Смотрю', en: 'Watching' },
                    unwatched_series_title: { ru: 'Непросмотренные серии', en: 'Unwatched series' }
                });
            }

            if (canOpenLibraryPage(lampa)) lampa.Component.add(PLUGIN_ID, libraryComponent(lampa));
            lampa.Menu.addButton(
                '<svg><use xlink:href="#sprite-calendar"></use></svg>',
                title(lampa, 'unwatched_series_title', 'Unwatched series'),
                function () { openLibrary(lampa); }
            );
        }
        catch (error) {
            return false;
        }

        initialized = true;
        return true;
    }

    function init(Lampa) {
        if (!Lampa) return false;
        if (register(Lampa)) return true;
        if (Lampa.Listener && Lampa.Listener.follow) {
            Lampa.Listener.follow('app', function (event) {
                if (event.type === 'ready') register(Lampa);
            });
        }
        return false;
    }

    return {
        COMPLETION_PERCENT: COMPLETION_PERCENT,
        RECENT_DAYS: RECENT_DAYS,
        TRACKED_TYPES: TRACKED_TYPES.slice(),
        FINISHED_TYPES: FINISHED_TYPES.slice(),
        trackedCards: trackedCards,
        episodeProgress: episodeProgress,
        buildModel: buildModel,
        displayEpisode: displayEpisode,
        libraryRows: libraryRows,
        init: init
    };
});
