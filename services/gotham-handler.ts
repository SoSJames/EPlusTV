import axios from 'axios';
import _ from 'lodash';
import jwt_decode from 'jwt-decode';
import moment from 'moment';
import CryptoJS from 'crypto-js';

import {getRandomUUID, normalTimeRange} from './shared-helpers';
import {db} from './database';
import {ClassTypeWithoutMethods, IEntry, IProvider, TChannelPlaybackInfo} from './shared-interfaces';
import {okHttpUserAgent} from './user-agent';
import {usesLinear} from './misc-db-service';
import {IMSGChannel, IMSGChannelGroup, MSG_LINEAR, MSG_PERMISSIONS, YES_PERMISSIONS} from './gotham-channels';

const API_KEY = [
  'G',
  'o',
  't',
  '9',
  'd',
  '3',
  '@',
  'Y',
  'E',
  '2',
  '4',
  'D',
  'E',
  'V',
  'M',
  'S',
  '4',
  '2',
  '#',
  'a',
  'p',
  'n',
  '9',
  '7',
  '7',
  '6',
].join('');

const CLIENT_SECRET = [
  'd',
  '5',
  'c',
  '8',
  'c',
  '7',
  '6',
  '7',
  '-',
  '2',
  '9',
  '9',
  'a',
  '-',
  '4',
  'd',
  'a',
  '7',
  '-',
  'a',
  '6',
  '1',
  '2',
  '-',
  '4',
  '1',
  '6',
  '4',
  'c',
  '5',
  '4',
  'a',
  '0',
  'e',
  '0',
  '9',
].join('');

const BASE_API_URL = ['https://', 'api.gothamsports.com', '/proxy'].join('');
const BASE_ADOBE_URL = ['https://', 'api.auth', '.adobe.com', '/api/v1'].join('');

interface IAppConfig {
  adobe: {
    SoftwareStatement: string;
    adobePassEnvURL: string;
  };
  RSNid: string;
  gameBackend: string;
}

interface IEntitlements {
  message: string;
  ovatToken: string;
  dmaID: string;
  AccountServiceMessage: {
    validityTill: number;
    ovpSKU: string;
    [key: string]: string | number | boolean;
  }[];
}

interface ISigningRes {
  secret: string;
  expiry: number;
  deviceId: string;
}

interface IAdobeUserMetadata {
  zip: string;
  hba_status: string;
  userID: string;
  mvpd: string;
}

const extractSidFromJWT = (accessToken: string) => {
  const {sid}: {sid: string} = jwt_decode(accessToken);
  return sid;
};

// Function to replace characters for Base64 URL encoding
const base64UrlEncode = (text: string) => text.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

// Function to convert a string to Base64 URL format
const utf8ToBase64Url = (text: string) => base64UrlEncode(CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(text)));

const JWTEncode = (header, payload, secretKey) => {
  // Create an array to hold the JWT segments
  const jwtSegments = [utf8ToBase64Url(JSON.stringify(header)), utf8ToBase64Url(JSON.stringify(payload))];

  // Calculate the HMAC signature based on the chosen algorithm
  const signature = base64UrlEncode(
    CryptoJS.HmacSHA256(jwtSegments.join('.'), secretKey).toString(CryptoJS.enc.Base64),
  );

  // Add the signature to the JWT segments and return the final JWT string
  jwtSegments.push(signature);

  return jwtSegments.join('.');
};

const parseAirings = async (events: any[]) => {
  const useLinear = await usesLinear();

  const [now, inTwoDays] = normalTimeRange();

  for (const event of events) {
    const entryExists = await db.entries.findOneAsync<IEntry>({id: `${event.contentId}`});

    if (!entryExists) {
      const start = moment(event.start);
      const end = moment(event.end);
      const originalEnd = moment(event.end);

      if (!useLinear) {
        start.subtract(30, 'minutes'); // For Pre-game
        end.add(1, 'hour');
      }

      if (end.isBefore(now) || start.isAfter(inTwoDays)) {
        continue;
      }

      console.log('Adding event: ', event.title);

      await db.entries.insertAsync<IEntry>({
        categories: event.categories.filter(a => a),
        duration: end.diff(start, 'seconds'),
        end: end.valueOf(),
        from: 'gotham',
        id: event.contentId,
        image: event.artwork,
        name: event.title,
        network: event.network || 'MSG',
        originalEnd: originalEnd.valueOf(),
        sport: event.sport,
        start: start.valueOf(),
        ...(event.linear && {
          channel: event.channel,
          linear: true,
        }),
      });
    }
  }
};

class GothamHandler {
  private access_token?: string;
  private entitlement_token?: string;
  private appConfig?: IAppConfig;
  private dma_id?: string;
  private entitlement_access: string[] = [];

  public device_id?: string;
  public auth_token?: string;
  public refresh_token?: string;
  public expiresIn?: number;
  public adobe_token?: string;
  public adobe_token_expires?: number;

  public initialize = async () => {
    const setup = (await db.providers.countAsync({name: 'gotham'})) > 0 ? true : false;

    if (!setup) {
      await db.providers.insertAsync<IProvider<TGothamTokens>>({
        enabled: false,
        name: 'gotham',
        tokens: {},
      });
    }

    const {enabled} = await db.providers.findOneAsync<IProvider>({name: 'gotham'});

    if (!enabled) {
      return;
    }

    // Load tokens from local file and make sure they are valid
    await this.load();

    await this.gothamInit();
  };

  private gothamInit = async () => {
    if (!this.appConfig) {
      await this.getAppConfig();
    }

    if (!this.access_token) {
      await this.getAccessToken();
    }

    if (!this.entitlement_token) {
      await this.getEntitlements();
    }
  };

  public refreshTokens = async () => {
    const {enabled} = await db.providers.findOneAsync<IProvider>({name: 'gotham'});

    if (!enabled) {
      return;
    }

    if (this.adobe_token) {
      await this.authenticateRegCode();
    }

    // Refresh access token and entitlements
    await this.getAccessToken();
    await this.getEntitlements();

    if (moment().add(20, 'hours').isAfter(this.expiresIn)) {
      console.log('Refreshing Gotham auth token');
      await this.getNewTokens();
    }

    if (this.adobe_token_expires && moment().isAfter(this.adobe_token_expires)) {
      console.log('Refreshing Gotham Adobe token');
      const didUpdate = await this.authenticateRegCode();

      if (!didUpdate) {
        this.adobe_token = undefined;
        this.adobe_token_expires = undefined;
        this.save();

        console.log('Gotham needs to reauthenticate with your TV Provider');
      }
    }
  };

  public getSchedule = async (): Promise<void> => {
    const {enabled} = await db.providers.findOneAsync<IProvider>({name: 'gotham'});

    if (!enabled) {
      return;
    }

    console.log('Looking for Gotham events...');

    const useLinear = await usesLinear();

    const [now, end] = normalTimeRange();

    const entries: any[] = [];

    try {
      if (useLinear) {
        if (this.dma_id) {
          for (const channel of Object.values(MSG_LINEAR[this.dma_id])) {
            if (
              !channel ||
              _.intersection(this.entitlement_access, channel.id === 'YES' ? YES_PERMISSIONS : MSG_PERMISSIONS)
                .length === 0
            ) {
              continue;
            }

            const url = [
              BASE_API_URL,
              '/content/epg',
              '?reg=',
              this.dma_id,
              '&dt=androidtv',
              '&channel=',
              channel.channelId,
              '&client=game-gotham-androidtv',
              '&start=',
              now.format('YYYY-MM-DDTHH:mm:ss[Z]'),
              '&end=',
              end.format('YYYY-MM-DDTHH:mm:ss[Z]'),
            ].join('');

            const {data} = await axios.get(url, {
              headers: {
                'gg-rsn-id': this.appConfig.RSNid,
                'user-agent': okHttpUserAgent,
              },
            });

            if ( !data.data ) {
              continue;
            }

            data.data.forEach(d => {
              d.airing.forEach(airing => {
                const eventName = airing.pgm.lon[0].n.replace(/\n/g, '');

                if (eventName !== 'NO PROGRAMMING - OFF AIR') {
                  entries.push({
                    artwork: `https://image-resizer-cloud-cdn.api.gamecms.quickplay.com/image/${airing.cid}/0-16x9.png?width=400`,
                    categories: [
                      'Gotham',
                      'HD',
                      'Sports',
                      airing.net || 'MSG',
                      airing.aw_tm,
                      airing.hm_tm,
                      airing.pgm.spt_lg,
                      airing.pgm.spt_ty,
                    ],
                    channel: channel.id,
                    contentId: `${airing.id}----${airing.cid}`,
                    end: airing.sc_ed_dt,
                    linear: true,
                    network: airing.net,
                    sport: airing.pgm.spt_lg,
                    start: airing.sc_st_dt,
                    title: eventName,
                  });
                }
              });
            });
          }
        }
      } else {
        const url = [
          BASE_API_URL,
          '/content/liveevent/filter',
          '?reg=',
          this.dma_id,
          '&dt=androidtv',
          '&client=game-gotham-androidtv',
          '&pageNumber=1',
          '&pageSize=40',
          '&team=',
          '&start=',
          now.format('YYYY-MM-DDTHH:mm:ss[Z]'),
          '&end=',
          end.format('YYYY-MM-DDTHH:mm:ss[Z]'),
        ].join('');

        const {data} = await axios.get(url, {
          headers: {
            'gg-rsn-id': this.appConfig.RSNid,
            'user-agent': okHttpUserAgent,
          },
        });

        data.data.forEach(airing => {
          if (!_.some(airing.ent, a => _.intersection(this.entitlement_access, a.sp).length > 0)) {
            return;
          }

          const eventName = airing.loen[0].n.replace(/\n/g, '');

          entries.push({
            artwork: `https://image-resizer-cloud-cdn.api.gamecms.quickplay.com/image/${airing.cid}/0-16x9.png?width=400`,
            categories: ['Gotham', 'HD', 'Sports', airing.net || 'MSG', airing.aw_tm, airing.hm_tm, airing.spt_lg],
            contentId: `${airing.id}----${airing.cid}`,
            end: airing.ev_ed_dt,
            network: `${airing.pn}`.toUpperCase(),
            sport: airing.spt_lg,
            start: airing.ev_st_dt,
            title: eventName,
          });
        });
      }
    } catch (e) {
      console.error(e);
      console.log('Could not get Gotham Sports Schedule');
    }

    await parseAirings(entries);
  };

  public getEventData = async (eventId: string): Promise<TChannelPlaybackInfo> => {
    try {
      const [, channelId] = eventId.split('----');

      const event = await db.entries.findOneAsync<IEntry>({id: eventId});

      const network = event.network === 'YES' ? 'YESN' : 'MSGGO';

      const authToken = await this.getPlaybackToken();
      const deviceIdToken = await this.getDeviceIdToken(authToken);

      let adobeMediaToken: string;

      if (this.adobe_token) {
        await this.pingAdobeAuth(network);
        adobeMediaToken = await this.getAdobeMediaToken(network);
      }

      const authUrl = [BASE_API_URL, '/media/content/authorize'].join('');

      const {data} = await axios.post(
        `${authUrl}`,
        {
          catalogType: 'channel',
          contentId: channelId,
          contentTypeId: 'live',
          delivery: 'streaming',
          deviceId: this.device_id,
          deviceName: 'web',
          drm: 'fairplay',
          mediaFormat: 'hls',
          playbackMode: 'live',
          urlParameters: {},
        },
        {
          headers: {
            Authorization: `Bearer ${authToken}`,
            'content-type': 'application/json',
            'gg-rsn-id': this.appConfig.RSNid,
            'user-agent': okHttpUserAgent,
            ...(adobeMediaToken && {
              'x-adobe-authorization': adobeMediaToken,
            }),
            'x-authorization': this.entitlement_token,
            'x-client-id': 'game-gotham-androidtv',
            'x-device-id': deviceIdToken,
          },
        },
      );

      if (!data) {
        throw new Error('Could not get stream data. Event might be upcoming, ended, or in blackout...');
      }

      return [data.data.contentUrl, {}];
    } catch (e) {
      console.error(e);
      console.log('Could not get stream information!');
    }
  };

  private getPlaybackToken = async (): Promise<string> => {
    try {
      const url = [BASE_API_URL, '/oauth2/token'].join('');

      const params = new URLSearchParams({
        audience: 'edge-service',
        client_id: 'android-ui-app',
        client_secret: CLIENT_SECRET,
        grant_type: 'client_credentials',
        scope: 'openid',
      });

      const {data} = await axios.post(url, params, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'gg-rsn-id': this.appConfig.RSNid,
          'user-agent': okHttpUserAgent,
        },
      });

      return data.access_token;
    } catch (e) {
      console.error(e);
      console.log('Could not get ');
    }
  };

  private registerDevice = async (): Promise<[string, string]> => {
    try {
      const url = ['https://', 'api.auth.adobe.com', '/o/client/register'].join('');

      const {data} = await axios.post(
        url,
        {
          software_statement: this.appConfig.adobe.SoftwareStatement,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'user-agent': okHttpUserAgent,
          },
        },
      );

      return [data.client_id, data.client_secret];
    } catch (e) {
      throw new Error('Could not register Adobe device');
    }
  };

  private getAccessToken = async (): Promise<void> => {
    const [client_id, client_secret] = await this.registerDevice();

    try {
      const url = ['https://', 'api.auth.adobe.com', '/o/client/token'].join('');

      const params = new URLSearchParams({
        client_id,
        client_secret,
        grant_type: 'client_credentials',
      });

      const {data} = await axios.post(url, params, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'user-agent': okHttpUserAgent,
        },
      });

      this.access_token = data.access_token;
    } catch (e) {
      console.error(e);
      console.log('Could not get MSG+ access token');
    }
  };

  private adobeParams = (resource: string): URLSearchParams => {
    return new URLSearchParams({
      deviceId: this.device_id,
      requestor: 'Gotham',
      resource,
    });
  };

  private pingAdobeAuth = async (resource: string): Promise<void> => {
    await this.authenticateRegCode();

    try {
      await axios.get(`${BASE_ADOBE_URL}/authorize?${this.adobeParams(resource)}`, {
        headers: {
          Authorization: `Bearer ${this.access_token}`,
          'user-agent': okHttpUserAgent,
        },
      });
    } catch (e) {
      console.error(e);
      console.log('Could not ping Adobe');
    }
  };

  private getAdobeMediaToken = async (resource: string): Promise<string> => {
    await this.authenticateRegCode();

    try {
      const {data} = await axios.get(`${BASE_ADOBE_URL}/tokens/media?${this.adobeParams(resource)}`, {
        headers: {
          Authorization: `Bearer ${this.access_token}`,
          'user-agent': okHttpUserAgent,
        },
      });

      return data.serializedToken;
    } catch (e) {
      console.error(e);
      console.log('Could not get Adobe Media token');
    }
  };

  private getAppConfig = async (): Promise<void> => {
    try {
      const url = ['https://', 'config.gothamsports.com', '/Configurations/v2/build.json'].join('');

      const {data} = await axios.get<IAppConfig>(url, {
        headers: {
          'user-agent': okHttpUserAgent,
        },
      });

      this.appConfig = data;
    } catch (e) {
      console.error(e);
      console.log('Could not get Gotham app config');
    }
  };

  public login = async (username: string, password: string): Promise<boolean> => {
    this.device_id = getRandomUUID();

    await this.gothamInit();

    try {
      const {data} = await axios.post(
        `${BASE_API_URL}/getOAuthAccessTokenv2`,
        {
          GetOAuthAccessTokenv2RequestMessage: {
            apiKey: API_KEY,
            channelPartnerID: 'GOTHAM',
            contactPassword: password,
            contactUserName: username,
            deviceMessage: {
              deviceName: 'onn. 4K Streaming Box',
              deviceType: 'AndroidTV',
              modelNo: 'onn onn. 4K Streaming Box',
              serialNo: this.device_id,
              userAgent: '',
            },
          },
        },
        {
          headers: {
            'gg-rsn-id': this.appConfig.RSNid,
            'user-agent': okHttpUserAgent,
          },
        },
      );

      if (data.gameError?.description && !data.GetOAuthAccessTokenv2ResponseMessage?.accessToken) {
        throw new Error(data.gameError?.description || 'Wrong Username or Password');
      }

      this.auth_token = data.GetOAuthAccessTokenv2ResponseMessage.accessToken;
      this.refresh_token = data.GetOAuthAccessTokenv2ResponseMessage.refreshToken;
      this.expiresIn = +data.GetOAuthAccessTokenv2ResponseMessage.expiresIn;

      await this.save();
      await this.getEntitlements();

      return true;
    } catch (e) {
      console.error(e, JSON.stringify(e));
      console.log('Could not login to Gotham with provided credentials!');
    }

    return false;
  };

  private getNewTokens = async (): Promise<void> => {
    try {
      const {data} = await axios.post(
        `${BASE_API_URL}/refreshToken`,
        {
          RefreshTokenRequestMessage: {
            apiKey: API_KEY,
            channelPartnerID: 'GOTHAM',
            refreshToken: this.refresh_token,
          },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            authorization: `Bearer ${this.auth_token}`,
            'gg-rsn-id': this.appConfig.RSNid,
            'user-agent': okHttpUserAgent,
          },
        },
      );

      this.auth_token = data.RefreshTokenResponseMessage.accessToken;
      this.refresh_token = data.RefreshTokenResponseMessage.refreshToken;
      this.expiresIn = +data.RefreshTokenResponseMessage.expiresIn;

      this.save();
    } catch (e) {
      console.error(e);
      console.log('Could not refresh tokens for Gotham!');
    }
  };

  private getEntitlements = async (): Promise<IEntitlements> => {
    if (!this.auth_token) {
      return;
    }

    try {
      const {data} = await axios.post<{GetEntitlementsResponseMessage: IEntitlements}>(
        `${BASE_API_URL}/getEntitlements`,
        {
          GetEntitlementsRequestMessage: {
            apiKey: API_KEY,
            channelPartnerID: 'GOTHAM',
          },
        },
        {
          headers: {
            authorization: `Bearer ${this.auth_token}`,
            'gg-rsn-id': this.appConfig.RSNid,
            'user-agent': okHttpUserAgent,
          },
        },
      );

      if (data?.GetEntitlementsResponseMessage?.message !== 'SUCCESS') {
        throw new Error('Could not get entitlements for Gotham');
      }

      this.entitlement_token = data.GetEntitlementsResponseMessage.ovatToken;
      this.dma_id = data.GetEntitlementsResponseMessage.dmaID;

      this.entitlement_access = data.GetEntitlementsResponseMessage.AccountServiceMessage.filter(a =>
        moment(a.validityTill).isAfter(moment()),
      ).map(a => a.ovpSKU);

      return data.GetEntitlementsResponseMessage;
    } catch (e) {
      console.error(e);
    }
  };

  private getDeviceIdToken = async (authToken: string): Promise<string> => {
    const secretRes = await this.getSigningSecret(authToken);

    const now = moment();
    const secretKey = CryptoJS.enc.Base64.parse(secretRes.secret);

    /* eslint-disable sort-keys-custom-order-fix/sort-keys-custom-order-fix */
    return JWTEncode(
      {
        alg: 'HS256',
        typ: 'JWT',
      },
      {
        deviceId: secretRes.deviceId,
        aud: 'playback-auth-service',
        iat: now.unix(),
        exp: moment(now).add(30, 'seconds').unix(),
      },
      secretKey,
    );
    /* eslint-enable sort-keys-custom-order-fix/sort-keys-custom-order-fix */
  };

  private getSigningSecret = async (authToken: string): Promise<ISigningRes> => {
    try {
      const {data} = await axios.post(
        `${BASE_API_URL}/device/app/register`,
        {
          uniqueId: this.device_id,
        },
        {
          headers: {
            authorization: `Bearer ${authToken}`,
            'gg-rsn-id': this.appConfig.RSNid,
            'user-agent': okHttpUserAgent,
            'x-authorization': this.entitlement_token,
            'x-client-id': 'game-gotham-androidtv',
          },
        },
      );

      return data.data;
    } catch (e) {
      console.error(e);
      console.log('Could not register device for Gotham');
    }
  };

  public getAuthCode = async (): Promise<string> => {
    try {
      const adobeUrl = ['https://', 'api.auth.adobe.com', '/reggie/v1', '/Gotham/regcode'].join('');

      const {data: gothamData} = await axios.post(
        `${BASE_API_URL}/generateDeviceActivationCode`,
        {
          GenerateDeviceActivationCodeRequestMessage: {
            apiKey: API_KEY,
            channelPartnerID: 'GOTHAM',
            deviceDetails: {
              deviceName: 'onn. 4K Streaming Box',
              deviceType: 'androidtv',
              modelNo: 'onn onn. 4K Streaming Box',
              serialNo: this.device_id,
            },
          },
        },
        {
          headers: {
            authorization: `Bearer ${this.auth_token}`,
            'gg-rsn-id': this.appConfig.RSNid,
            'user-agent': okHttpUserAgent,
          },
        },
      );

      const gothamCode = gothamData.GenerateDeviceActivationCodeResponseMessage.activationCode;

      if (!gothamCode) {
        return 'Loading...';
      }

      const adobeParams = new URLSearchParams({
        deviceId: this.device_id,
      });

      const {data: adobeData} = await axios.post(adobeUrl, adobeParams, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          authorization: `Bearer ${this.access_token}`,
          'user-agent': okHttpUserAgent,
        },
      });

      const adobeCode = adobeData.code;

      const sid = extractSidFromJWT(this.auth_token);
      const hashedSid = Buffer.from(sid).toString('base64');

      return `https://auth.gothamsports.com/authenticate/${adobeCode}/androidtv/${gothamCode}?spAccountId=${hashedSid}`;
    } catch (e) {
      console.error(e);
      console.log('Could not start the authentication process for Gotham!');
    }
  };

  public authenticateRegCode = async (): Promise<boolean> => {
    try {
      const entitlements = await this.getEntitlements();

      if (!entitlements.AccountServiceMessage.length) {
        return false;
      }

      const {data} = await axios.post(
        `${BASE_API_URL}/generateDeviceActivationCode`,
        {
          GenerateDeviceActivationCodeRequestMessage: {
            apiKey: API_KEY,
            channelPartnerID: 'GOTHAM',
            deviceDetails: {
              deviceName: 'onn. 4K Streaming Box',
              deviceType: 'androidtv',
              modelNo: 'onn onn. 4K Streaming Box',
              serialNo: this.device_id,
            },
          },
        },
        {
          headers: {
            authorization: `Bearer ${this.auth_token}`,
            'gg-rsn-id': this.appConfig.RSNid,
            'user-agent': okHttpUserAgent,
          },
        },
      );

      if (
        !data.GenerateDeviceActivationCodeResponseMessage ||
        data.GenerateDeviceActivationCodeResponseMessage?.message !== 'SUCCESS' ||
        !data.GenerateDeviceActivationCodeResponseMessage?.accessToken
      ) {
        return false;
      }

      this.adobe_token_expires = +data.GenerateDeviceActivationCodeResponseMessage.expiresIn;
      this.adobe_token = data.GenerateDeviceActivationCodeResponseMessage.accessToken;

      this.save();

      const adobeId = await this.getAdobeId();
      const adobeUserMeta = await this.getUserMetadata();

      await this.preAuthDevice();
      await this.addTVESubscription(adobeId, adobeUserMeta);
      await this.getEntitlements();

      return true;
    } catch (e) {
      return false;
    }
  };

  public getLinearChannels = _.throttle((): IMSGChannelGroup => {
    const channelObj = _.cloneDeep(MSG_LINEAR[this.dma_id]);

    if (!channelObj) {
      return {};
    }

    for (const channelNum of Object.keys(channelObj)) {
      const channel: IMSGChannel = channelObj[channelNum];

      if (
        !channel ||
        _.intersection(this.entitlement_access, channel.id === 'YES' ? YES_PERMISSIONS : MSG_PERMISSIONS).length === 0
      ) {
        delete channelObj[channelNum];
        continue;
      }

      channel.checkChannelEnabled = async () => {
        const {enabled} = await db.providers.findOneAsync<IProvider>({name: 'gotham'});

        return enabled;
      };
    }

    return channelObj;
  }, 15 * 1000);

  private getAdobeId = async (): Promise<string> => {
    try {
      const {data} = await axios.post(
        `${BASE_API_URL}/getContact`,
        {
          GetContactRequestMessage: {
            apiKey: API_KEY,
            channelPartnerID: 'GOTHAM',
          },
        },
        {
          headers: {
            authorization: `Bearer ${this.auth_token}`,
            'gg-rsn-id': this.appConfig.RSNid,
            'user-agent': okHttpUserAgent,
          },
        },
      );

      return data.GetContactResponseMessage.adobeID;
    } catch (e) {
      console.error(e);
      console.log('Could not get Adobe ID for Gotham!');
    }
  };

  private getUserMetadata = async (): Promise<IAdobeUserMetadata> => {
    try {
      const url = [BASE_ADOBE_URL, '/tokens/usermetadata', '?deviceId=', this.device_id, '&requestor=Gotham'].join('');

      const {data} = await axios.get<{data: IAdobeUserMetadata}>(url, {
        headers: {
          Authorization: `Bearer ${this.access_token}`,
          'User-Agent': okHttpUserAgent,
        },
      });

      return data.data;
    } catch (e) {
      console.error(e);
      console.log('Could not get user meta for Gotham!');
    }
  };

  private preAuthDevice = async (): Promise<void> => {
    try {
      const url = [
        'https://',
        'api.auth.adobe.com',
        '/api/v1/preauthorize',
        '?deviceId=',
        this.device_id,
        '&requestor=Gotham',
        '&resource=YESN,MSGGO',
      ].join('');

      await axios.get(url, {
        headers: {
          authorization: `Bearer ${this.access_token}`,
          'gg-rsn-id': this.appConfig.RSNid,
          'user-agent': okHttpUserAgent,
        },
      });
    } catch (e) {
      console.error(e);
      console.log('Could not pre-auth device for Gotham!');
    }
  };

  private addTVESubscription = async (adobeId: string, adobeUserMeta: IAdobeUserMetadata): Promise<void> => {
    try {
      await axios.post(
        `${BASE_API_URL}/addTVESubscription`,
        {
          AddTVESubscriptionRequestMessage: {
            adobeId,
            adobeResource: ['MSGGO', 'YESN'],
            apiKey: API_KEY,
            channelPartnerID: 'GOTHAM',
            deviceID: this.device_id,
            encryptedZip: adobeUserMeta.zip,
            mvpdID: adobeUserMeta.mvpd,
          },
        },
        {
          headers: {
            authorization: `Bearer ${this.auth_token}`,
            'gg-rsn-id': this.appConfig.RSNid,
            'user-agent': okHttpUserAgent,
          },
        },
      );
    } catch (e) {
      console.error(e);
      console.log('Could not add TVE subscription for Gotham!');
    }
  };

  private save = async () => {
    await db.providers.updateAsync(
      {name: 'gotham'},
      {$set: {tokens: _.omit(this, 'appConfig', 'access_token', 'entitlement_token', 'dma_id', 'entitlement_access')}},
    );
  };

  private load = async () => {
    const {tokens} = await db.providers.findOneAsync<IProvider<TGothamTokens>>({name: 'gotham'});
    const {device_id, auth_token, refresh_token, expiresIn, adobe_token_expires, adobe_token} = tokens || {};

    this.device_id = device_id;
    this.auth_token = auth_token;
    this.refresh_token = refresh_token;
    this.expiresIn = expiresIn;
    this.adobe_token_expires = adobe_token_expires;
    this.adobe_token = adobe_token;
  };
}

export type TGothamTokens = ClassTypeWithoutMethods<GothamHandler>;

export const gothamHandler = new GothamHandler();
