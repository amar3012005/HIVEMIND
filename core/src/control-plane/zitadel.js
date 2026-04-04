function ensureNoTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function decodeJwtPayload(token) {
  const [, payload] = token.split('.');
  if (!payload) {
    return {};
  }

  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

export class ZitadelOidcClient {
  constructor(config) {
    this.config = {
      scope: 'openid profile email offline_access',
      ...config
    };
    this.issuer = ensureNoTrailingSlash(this.config.issuerUrl);
  }

  buildAuthorizeUrl(state, options = {}) {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: 'code',
      redirect_uri: this.config.redirectUri,
      scope: this.config.scope,
      state
    });

    // Pass through OIDC hints for IdP pre-selection (e.g. Google)
    if (options.idpHint) {
      params.set('idp_hint', options.idpHint);
    }
    if (options.loginHint) {
      params.set('login_hint', options.loginHint);
    }
    // prompt=create shows Zitadel's registration screen instead of login
    if (options.prompt) {
      params.set('prompt', options.prompt);
    }

    return `${this.issuer}/oauth/v2/authorize?${params.toString()}`;
  }

  async exchangeCode(code) {
    const response = await fetch(`${this.issuer}/oauth/v2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.config.redirectUri,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret
      })
    });

    if (!response.ok) {
      throw new Error(`Token exchange failed with status ${response.status}`);
    }

    return response.json();
  }

  async getUserInfo(accessToken) {
    const response = await fetch(`${this.issuer}/oidc/v1/userinfo`, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Userinfo fetch failed with status ${response.status}`);
    }

    return response.json();
  }

  async exchangeAndResolveUser(code) {
    const tokenSet = await this.exchangeCode(code);
    const claims = tokenSet.id_token ? decodeJwtPayload(tokenSet.id_token) : {};
    const userInfo = tokenSet.access_token ? await this.getUserInfo(tokenSet.access_token) : {};

    return {
      tokenSet,
      claims,
      userInfo: {
        sub: userInfo.sub || claims.sub,
        email: userInfo.email || claims.email,
        name: userInfo.name || claims.name || claims.preferred_username || null,
        givenName: userInfo.given_name || claims.given_name || null,
        familyName: userInfo.family_name || claims.family_name || null,
        picture: userInfo.picture || claims.picture || null,
        locale: userInfo.locale || claims.locale || 'en',
        emailVerified: Boolean(userInfo.email_verified ?? claims.email_verified)
      }
    };
  }
}
