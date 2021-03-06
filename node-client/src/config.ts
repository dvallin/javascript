import fs = require('fs');
import https = require('https');
import os = require('os');
import path = require('path');

import base64 = require('base-64');
import yaml = require('js-yaml');
import jsonpath = require('jsonpath');
import request = require('request');
import shelljs = require('shelljs');
import api = require('./api');
import { Cluster, Context, newClusters, newContexts, newUsers, User } from './config_types';

import client = require('./auth-wrapper');

export class KubeConfig {

    // Only really public for testing...
    public static findObject(list: any[], name: string, key: string) {
        for (const obj of list) {
            if (obj.name === name) {
                if (obj[key]) {
                    return obj[key];
                }
                return obj;
            }
        }
        return null;
    }

    /**
     * The list of all known clusters
     */
    public 'clusters': Cluster[];

    /**
     * The list of all known users
     */
    public 'users': User[];

    /**
     * The list of all known contexts
     */
    public 'contexts': Context[];

    /**
     * The name of the current context
     */
    public 'currentContext': string;

    public getContexts() {
        return this.contexts;
    }

    public getClusters() {
        return this.clusters;
    }

    public getUsers() {
        return this.users;
    }

    public getCurrentContext() {
        return this.currentContext;
    }

    public setCurrentContext(context: string) {
        this.currentContext = context;
    }

    public getContextObject(name: string) {
        return KubeConfig.findObject(this.contexts, name, 'context');
    }

    public getCurrentCluster() {
        return this.getCluster(this.getCurrentContextObject().cluster);
    }

    public getCluster(name: string): Cluster {
        return KubeConfig.findObject(this.clusters, name, 'cluster');
    }

    public getCurrentUser() {
        return this.getUser(this.getCurrentContextObject().user);
    }

    public getUser(name: string): User {
        return KubeConfig.findObject(this.users, name, 'user');
    }

    public loadFromFile(file: string) {
        this.loadFromString(fs.readFileSync(file, 'utf8'));
    }

    public applytoHTTPSOptions(opts: https.RequestOptions) {
        const user = this.getCurrentUser();

        this.applyOptions(opts);

        if (user.username) {
            opts.auth = `${user.username}:${user.password}`;
        }
    }

    public applyToRequest(opts: request.Options) {
        const cluster = this.getCurrentCluster();
        const user = this.getCurrentUser();

        this.applyOptions(opts);

        if (cluster.skipTLSVerify) {
            opts.strictSSL = false;
        }

        if (user.username) {
            opts.auth = {
                password: user.password,
                username: user.username,
            };
        }
    }

    public loadFromString(config: string) {
        const obj = yaml.safeLoad(config) as any;
        if (obj.apiVersion !== 'v1') {
            throw new TypeError('unknown version: ' + obj.apiVersion);
        }
        this.clusters = newClusters(obj.clusters);
        this.contexts = newContexts(obj.contexts);
        this.users = newUsers(obj.users);
        this.currentContext = obj['current-context'];
    }

    public loadFromCluster() {
        const host = process.env.KUBERNETES_SERVICE_HOST;
        const port = process.env.KUBERNETES_SERVICE_PORT;
        const clusterName = 'inCluster';
        const userName = 'inClusterUser';
        const contextName = 'inClusterContext';

        let scheme = 'https';
        if (port === '80' || port === '8080' || port === '8001') {
            scheme = 'http';
        }

        this.clusters = [
            {
                name: clusterName,
                caFile: Config.SERVICEACCOUNT_CA_PATH,
                caData: null,
                server: `${scheme}://${host}:${port}`,
                skipTLSVerify: false,
            },
        ];
        this.users = [
            {
                name: userName,
                token: fs.readFileSync(Config.SERVICEACCOUNT_TOKEN_PATH).toString(),
                // empty defaults, fields are required...
                certData: null,
                certFile: null,
                keyData: null,
                keyFile: null,
                authProvider: null,
                username: null,
                password: null,
            },
        ];
        this.contexts = [
            {
                cluster: clusterName,
                name: contextName,
                user: userName,
            },
        ];
        this.currentContext = contextName;
    }

    private getCurrentContextObject() {
        return this.getContextObject(this.currentContext);
    }

    private bufferFromFileOrString(file: string, data: string) {
        if (file) {
            return fs.readFileSync(file);
        }
        if (data) {
            return Buffer.from(base64.decode(data), 'utf-8');
        }
        return null;
    }

    private applyHTTPSOptions(opts: request.Options | https.RequestOptions) {
        const cluster = this.getCurrentCluster();
        const user = this.getCurrentUser();

        opts.ca = this.bufferFromFileOrString(cluster.caFile, cluster.caData);
        opts.cert = this.bufferFromFileOrString(user.certFile, user.certData);
        opts.key = this.bufferFromFileOrString(user.keyFile, user.keyData);
    }

    private applyAuthorizationHeader(opts: request.Options | https.RequestOptions) {
        const user = this.getCurrentUser();
        let token = null;

        if (user.authProvider && user.authProvider.config) {
            const config = user.authProvider.config;
            // This should probably be extracted as auth-provider specific plugins...
            token = 'Bearer ' + config['access-token'];
            const expiry = config.expiry;

            if (expiry) {
                const expiration = Date.parse(expiry);
                if (expiration < Date.now()) {
                    if (config['cmd-path']) {
                        let cmd = '"' + config['cmd-path'] + '"';
                        if (config['cmd-args']) {
                            cmd = cmd + ' ' + config['cmd-args'];
                        }
                        // TODO: Cache to file?
                        const result = shelljs.exec(cmd, { silent: true });
                        if (result.code !== 0) {
                            throw new Error('Failed to refresh token: ' + result.stderr);
                        }
                        const resultObj = JSON.parse(result.stdout.toString());

                        let pathKey = config['token-key'];
                        // Format in file is {<query>}, so slice it out and add '$'
                        pathKey = '$' + pathKey.slice(1, -1);

                        config['access-token'] = jsonpath.query(resultObj, path);
                        token = 'Bearer ' + config['access-token'];
                    } else {
                        throw new Error('Token is expired!');
                    }
                }
            }

        }

        if (user.token) {
            token = 'Bearer ' + user.token;
        }

        if (token) {
            if (!opts.headers) {
                opts.headers = [];
            }
            opts.headers.Authorization = token;
        }
    }

    private applyOptions(opts: request.Options | https.RequestOptions) {
        this.applyHTTPSOptions(opts);
        this.applyAuthorizationHeader(opts);
    }
}

export class Config {
    public static SERVICEACCOUNT_ROOT =
    '/var/run/secrets/kubernetes.io/serviceaccount';
    public static SERVICEACCOUNT_CA_PATH =
    Config.SERVICEACCOUNT_ROOT + '/ca.crt';
    public static SERVICEACCOUNT_TOKEN_PATH =
    Config.SERVICEACCOUNT_ROOT + '/token';

    public static fromFile(filename: string): api.Core_v1Api {
        const kc = new KubeConfig();
        kc.loadFromFile(filename);

        const k8sApi = new client.Core_v1Api(kc.getCurrentCluster().server);
        k8sApi.setDefaultAuthentication(kc);

        return k8sApi;
    }

    public static fromCluster(): api.Core_v1Api {
        const host = process.env.KUBERNETES_SERVICE_HOST;
        const port = process.env.KUBERNETES_SERVICE_PORT;

        // TODO: better error checking here.
        const caCert = fs.readFileSync(Config.SERVICEACCOUNT_CA_PATH);
        const token = fs.readFileSync(Config.SERVICEACCOUNT_TOKEN_PATH);

        const k8sApi = new client.Core_v1Api('https://' + host + ':' + port);
        k8sApi.setDefaultAuthentication({
            applyToRequest: (opts) => {
                opts.ca = caCert;
                if (!opts.headers) {
                    opts.headers = [];
                }
                opts.headers.Authorization = 'Bearer ' + token;
            },
        });

        return k8sApi;
    }

    public static defaultClient(): api.Core_v1Api {
        if (process.env.KUBECONFIG) {
            return Config.fromFile(process.env.KUBECONFIG);
        }

        const config = path.join(process.env.HOME, '.kube', 'config');
        if (fs.existsSync(config)) {
            return Config.fromFile(config);
        }

        if (fs.existsSync(Config.SERVICEACCOUNT_TOKEN_PATH)) {
            return Config.fromCluster();
        }

        return new client.Core_v1Api('http://localhost:8080');
    }
}
