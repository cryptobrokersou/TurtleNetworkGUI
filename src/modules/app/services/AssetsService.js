(function () {
    'use strict';

    /**
     * @param {app.utils.apiWorker} apiWorker
     * @param {app.utils.decorators} decorators
     * @param {User} user
     * @param {app.utils} utils
     * @param {EventManager} eventManager
     * @return {AssetsService}
     */
    const factory = function (apiWorker, decorators, user, utils, eventManager) {

        const ASSET_NAME_MAP = {
            [WavesApp.defaultAssets.ETH]: 'Ethereum',
            [WavesApp.defaultAssets.EUR]: 'Euro',
            [WavesApp.defaultAssets.USD]: 'Usd',
            [WavesApp.defaultAssets.BTC]: 'Bitcoin'
        };

        class AssetsService {

            /**
             * @param {string} assetId
             * @return {Promise<IAssetInfo>}
             */
            @decorators.cachable()
            getAssetInfo(assetId) {
                if (assetId === WavesApp.defaultAssets.WAVES) {
                    return user.onLogin()
                        .then(() => this.getMoneyList([{ count: '100000000', id: WavesApp.defaultAssets.WAVES }]))
                        .then(([quantity]) => ({
                            id: WavesApp.defaultAssets.WAVES,
                            name: 'Waves',
                            precision: 8,
                            reissuable: false,
                            quantity: quantity,
                            timestamp: 1460408400000,
                            sender: WavesApp.defaultAssets.WAVES
                        }));
                }
                return user.onLogin()
                    .then(() => {
                        return apiWorker.process((Waves, { assetId }) => {
                            return Waves.API.Node.v2.transactions.get(assetId);
                        }, { assetId })
                            .then((asset) => ({
                                id: asset.id,
                                name: ASSET_NAME_MAP[asset.id] || asset.name,
                                description: asset.description,
                                precision: asset.precision,
                                reissuable: asset.reissuable,
                                quantity: asset.amount,
                                timestamp: asset.timestamp,
                                sender: asset.sender,
                                height: asset.height
                            }));
                    });
            }

            /**
             * @param {string} assetId
             * @return {Promise<IAssetWithBalance>}
             */
            getBalance(assetId) {
                return this.getBalanceList([assetId])
                    .then(([asset]) => {
                        return asset;
                    });
            }

            /**
             * @param {string[]} [assetIds]
             * @param {Object} [options]
             * @param {Object} [options.limit]
             * @param {Object} [options.offset]
             * @return {Promise}
             */
            getBalanceList(assetIds) {
                return utils.whenAll([
                    this._getBalanceList(),
                    eventManager.getBalanceEvents()
                ])
                    .then(([balanceList, events]) => {
                        if (!assetIds) {
                            const promiseList = balanceList.map((item) => this.getAssetInfo(item.id));
                            return utils.whenAll(promiseList)
                                .then((infoList) => {
                                    return infoList.map((asset, index) => {
                                        const amount = balanceList[index].amount;
                                        const balance = this._getAssetBalance(asset.id, amount, events);
                                        return this.getMoney(balance.toFixed(asset.precision), asset.id)
                                            .then((money) => ({ ...asset, balance: money }));
                                    });
                                })
                                .then(utils.whenAll);
                        } else {
                            const balances = utils.toHash(balanceList, 'id');
                            return utils.whenAll(assetIds.map(this.getAssetInfo))
                                .then((assetList) => {
                                    return assetList.map((asset) => {
                                        if (balances[asset.id]) {
                                            const tokens = this._getAssetBalance(asset.id, balances[asset.id].amount, events);
                                            return this.getMoney(tokens.toFixed(asset.precision), asset.id)
                                                .then((money) => ({ ...asset, balance: money }));
                                        } else {
                                            return this.getMoney('0', asset.id)
                                                .then((money) => ({ ...asset, balance: money }));
                                        }
                                    });
                                })
                                .then(utils.whenAll);
                        }
                    });

            }

            getMoneyList(moneyData) {
                return apiWorker.process((Waves, moneyData) => {
                    return Promise.all(moneyData.map(({ count, id }) => Waves.Money.fromTokens(count, id)));
                }, moneyData);
            }

            getMoney(balance, id) {
                return this.getMoneyList([{ count: balance, id }]).then(([money]) => money);
            }

            @decorators.cachable(2)
            getBidAsk(assetId1, assetId2) {
                return apiWorker.process((Waves, { assetId1, assetId2 }) => {
                    return Waves.API.Matcher.v1.getOrderbook(assetId1, assetId2)
                        .then((orderbook) => {
                            const bid = String(orderbook.bids.length && orderbook.bids[0].price || 0);
                            const ask = String(orderbook.asks.length && orderbook.asks[0].price || 0);

                            return Promise.all([
                                Waves.OrderPrice.fromTokens(bid, assetId1, assetId2)
                                    .then((item) => item.getTokens()),
                                Waves.OrderPrice.fromTokens(ask, assetId1, assetId2)
                                    .then((item) => item.getTokens())
                            ])
                                .then((list) => ({ bid: list[0], ask: list[1] }));
                        });
                }, { assetId1, assetId2 });
            }

            @decorators.cachable(60)
            getChange(idFrom, idTo) {
                const marketUrl = 'https://marketdata.wavesplatform.com/api/candles';

                const params = {
                    onFetch: utils.onFetch,
                    wavesId: WavesApp.defaultAssets.WAVES,
                    idFrom,
                    idTo,
                    marketUrl
                };

                return apiWorker.process((Waves, { onFetch, wavesId, idFrom, idTo, marketUrl }) => {

                    if (idFrom === idTo) {
                        return 1;
                    }

                    const getChange = function (from, to) {
                        return Waves.AssetPair.get(from, to)
                            .then((pair) => {
                                return fetch(`${marketUrl}/${pair.toString()}/1440/1`)
                                    .then(onFetch)
                                    .then((data) => {
                                        if (!data || !data.length) {
                                            return 0;
                                        }
                                        const open = Number(data[0].open);
                                        const close = Number(data[0].close);
                                        if (open > close) {
                                            return close === 0 ? 0 : -open / close;
                                        } else {
                                            return open === 0 ? 0 : close / open;
                                        }
                                    });
                            });
                    };

                    if (idFrom !== wavesId && idTo !== wavesId) {
                        return Promise.all([
                            getChange(idFrom, wavesId),
                            getChange(idTo, wavesId)
                        ])
                            .then((rateList) => {
                                return rateList[1] === 0 ? 0 : rateList[0] / rateList[1];
                            });
                    } else {
                        return getChange(idFrom, idTo);
                    }

                }, params);
            }

            /**
             * @param {string} idFrom
             * @param {string} idTo
             * @return {Promise<AssetsService.rateApi>}
             */
            @decorators.cachable(60)
            getRate(idFrom, idTo) {
                const marketUrl = 'https://marketdata.wavesplatform.com/api/trades';

                const params = {
                    onFetch: utils.onFetch,
                    wavesId: WavesApp.defaultAssets.WAVES,
                    idFrom,
                    idTo,
                    marketUrl
                };

                return apiWorker.process((Waves, { onFetch, wavesId, idFrom, idTo, marketUrl }) => {

                    if (idFrom === idTo) {
                        return 1;
                    }

                    const currentRate = (trades) => {
                        return trades && trades.length ? trades.reduce((result, item) => {
                            return result.add(new WavesAPI.BigNumber(item.price));
                        }, new WavesAPI.BigNumber(0))
                            .div(trades.length) : new WavesAPI.BigNumber(0);
                    };

                    const getRate = function (from, to) {
                        return Waves.AssetPair.get(from, to)
                            .then((pair) => {
                                return fetch(`${marketUrl}/${pair.toString()}/5`)
                                    .then(onFetch)
                                    .then(currentRate)
                                    .then((rate) => {
                                        if (from !== pair.priceAsset.id) {
                                            return rate;
                                        } else {
                                            return rate.eq(0) ? rate : new WavesAPI.BigNumber(1).div(rate);
                                        }
                                    }).catch((e) => {
                                        return new WavesAPI.BigNumber(0);
                                    });
                            });
                    };

                    if (idFrom !== wavesId && idTo !== wavesId) {
                        return Promise.all([
                            getRate(idFrom, wavesId),
                            getRate(idTo, wavesId)
                        ])
                            .then((rateList) => {
                                return rateList[1].eq(0) ? rateList[1] : rateList[0].div(rateList[1]);
                            });
                    } else {
                        return getRate(idFrom, idTo);
                    }

                }, params)
                    .then((rate) => {
                        return this._generateRateApi(rate);
                    });
            }

            @decorators.cachable(20)
            getRateHistory(fromId, toId, time, count) {
                const params = {
                    onFetch: utils.onFetch,
                    time, count,
                    fromId, toId,
                    wavesId: WavesApp.defaultAssets.WAVES,
                    marketUrl: 'https://marketdata.wavesplatform.com/api/candles'
                };

                return apiWorker.process((Waves, { onFetch, time, count, fromId, toId, marketUrl, wavesId }) => {

                    const getRateHistory = function (from, to) {
                        return Waves.AssetPair.get(from, to)
                            .then((pair) => {
                                return fetch(`${marketUrl}/${pair.toString()}/${time}/${count}`)
                                    .then(onFetch)
                                    .then((list) => {
                                        if (!list || !list.length) {
                                            return Promise.reject(list);
                                        }

                                        return list.reduce((result, item) => {
                                            const close = Number(item.close);
                                            let rate = from !== pair.priceAsset.id ? close : 1 / close;

                                            if (close !== 0) {
                                                result.push({
                                                    timestamp: new Date(item.timestamp),
                                                    rate: rate
                                                });
                                            }

                                            return result;
                                        }, []);
                                    });
                            });
                    };

                    if (fromId !== wavesId && toId !== wavesId) {
                        return Promise.all([
                            getRateHistory(fromId, wavesId),
                            getRateHistory(toId, wavesId)
                        ])
                            .then((rateList) => {
                                const from = rateList[0];
                                const to = rateList[1];

                                const toHash = function (list) {
                                    return list.reduce((result, item) => {
                                        result[item.timestamp.valueOf()] = item;
                                        return result;
                                    }, Object.create(null));
                                };

                                const hash = toHash(to);

                                return from.reduce((result, item) => {
                                    if (hash[item.timestamp.valueOf()]) {
                                        item.rate = item.rate / hash[item.timestamp.valueOf()].rate;
                                        result.push(item);
                                    }
                                    return result;
                                }, []);
                            });
                    } else {
                        return getRateHistory(fromId, toId);
                    }

                }, params);
            }

            /**
             * @return {Promise<Money>}
             */
            getFeeSend() {
                return apiWorker.process((Waves, id) => {
                    return Waves.Money.fromTokens('0.001', id);
                }, WavesApp.defaultAssets.WAVES);
            }

            /**
             * @param {string} assetId
             * @param {Money} money
             * @param {Array<ChangeBalanceEvent>} events
             * @return {BigNumber}
             * @private
             */
            _getAssetBalance(assetId, money, events) {
                return events.reduce((balance, balanceEvent) => {
                    return balance.sub(balanceEvent.getBalanceDifference(assetId));
                }, money.getTokens());
            }

            /**
             * @private
             */
            @decorators.cachable(1)
            _getBalanceList() {
                return user.onLogin()
                    .then(() => {
                        return apiWorker.process((WavesAPI, { address }) => {
                            return WavesAPI.API.Node.v2.addresses.balances(address); // TODO Add limits. Author Tsigel at 14/11/2017 09:04
                        }, { address: user.address });
                    });
            }

            /**
             * @param {number} rate
             * @return {AssetsService.rateApi}
             * @private
             */
            _generateRateApi(rate) {
                return {
                    /**
                     * @name AssetsService.rateApi#exchange
                     * @param {BigNumber} balance
                     * @return {BigNumber}
                     */
                    exchange(balance) {
                        return balance.mul(rate.toFixed(8));
                    },

                    /**
                     * @name AssetsService.rateApi#exchangeReverse
                     * @param {BigNumber} balance
                     * @return {BigNumber}
                     */
                    exchangeReverse(balance) {
                        return rate ? balance.div(rate) : 0;
                    },

                    /**
                     * @name AssetsService.rateApi#rate
                     */
                    rate
                };
            }

        }

        return utils.bind(new AssetsService());
    };

    factory.$inject = ['apiWorker', 'decorators', 'user', 'utils', 'eventManager'];

    angular.module('app')
        .factory('assetsService', factory);
})();

/**
 * @name AssetsService.rateApi
 */

/**
 * @typedef {Object} IBalance
 * @property {string} id
 * @property {number} precision
 * @property {number} balance
 */

/**
 * @typedef {Object} IAssetInfo
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {number} precision
 * @property {boolean} reissuable
 * @property {number} quantity
 * @property {number} timestamp
 */

/**
 * @typedef {Object} IAssetWithBalance
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {number} precision
 * @property {BigNumber} balance
 * @property {boolean} reissuable
 * @property {number} quantity
 * @property {number} timestamp
 */
