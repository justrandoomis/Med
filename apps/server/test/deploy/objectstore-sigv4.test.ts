// PL-0: Signature Version 4 checked against the examples AWS publishes (IAM «create a signed request» example and the
// four S3 «Authorization header» examples). A signer that only agrees with its own fake server proves nothing.
import { describe, expect, it } from 'vitest';
import { amzDate, awsUriEncode, canonicalQuery, EMPTY_SHA256, encodePath, parseAuthorization, sha256Hex, signRequest } from '../../src/lib/objectstore/sigv4';

const S3_CREDS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: () => 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const S3_DATE = '20130524T000000Z';
const S3_HOST = 'examplebucket.s3.amazonaws.com';
const s3 = { region: 'us-east-1', service: 's3', datetime: S3_DATE };

describe('SigV4 — AWS published examples', () => {
  it('IAM ListUsers (GET with a query string)', () => {
    const sig = signRequest(
      {
        method: 'GET',
        path: '/',
        query: { Action: 'ListUsers', Version: '2010-05-08' },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', Host: 'iam.amazonaws.com', 'X-Amz-Date': '20150830T123600Z' },
        payloadHash: EMPTY_SHA256,
        region: 'us-east-1',
        service: 'iam',
        datetime: '20150830T123600Z',
      },
      { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: () => 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
    );
    expect(sig.signature).toBe('5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
    expect(sig.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
  });

  it('S3 GET Object with a Range header', () => {
    const sig = signRequest({ ...s3, method: 'GET', path: '/test.txt', headers: { host: S3_HOST, range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': S3_DATE }, payloadHash: EMPTY_SHA256 }, S3_CREDS);
    expect(sig.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('S3 PUT Object (a key with «$», a Date header and a storage class)', () => {
    const body = 'Welcome to Amazon S3.';
    const hash = sha256Hex(body);
    expect(hash).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    const sig = signRequest(
      {
        ...s3,
        method: 'PUT',
        path: encodePath(['test$file.text']),
        headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', host: S3_HOST, 'x-amz-content-sha256': hash, 'x-amz-date': S3_DATE, 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
        payloadHash: hash,
      },
      S3_CREDS,
    );
    expect(encodePath(['test$file.text'])).toBe('/test%24file.text');
    expect(sig.signature).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });

  it('S3 GET Bucket Lifecycle (a value-less sub-resource)', () => {
    const sig = signRequest({ ...s3, method: 'GET', path: '/', query: { lifecycle: '' }, headers: { host: S3_HOST, 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': S3_DATE }, payloadHash: EMPTY_SHA256 }, S3_CREDS);
    expect(sig.signature).toBe('fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  });

  it('S3 GET Bucket (List Objects) with sorted query parameters', () => {
    const sig = signRequest({ ...s3, method: 'GET', path: '/', query: { prefix: 'J', 'max-keys': '2' }, headers: { host: S3_HOST, 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': S3_DATE }, payloadHash: EMPTY_SHA256 }, S3_CREDS);
    expect(sig.signature).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });
});

describe('SigV4 helpers', () => {
  it('URI-encodes like AWS (RFC 3986 unreserved only), per path segment', () => {
    expect(awsUriEncode("a b+c/d*e!'()~._-")).toBe('a%20b%2Bc%2Fd%2Ae%21%27%28%29~._-');
    expect(encodePath(['bucket', 'medlevo/backups/x y.mlenc'])).toBe('/bucket/medlevo/backups/x%20y.mlenc');
    expect(canonicalQuery({ uploadId: 'a/b=', partNumber: '2' })).toBe('partNumber=2&uploadId=a%2Fb%3D');
  });

  it('formats x-amz-date and parses an Authorization header', () => {
    expect(amzDate(Date.UTC(2013, 4, 24, 0, 0, 0))).toBe('20130524T000000Z');
    const a = parseAuthorization('AWS4-HMAC-SHA256 Credential=AKID/20130524/auto/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=' + 'a'.repeat(64));
    expect(a).toEqual({ accessKeyId: 'AKID', scope: '20130524/auto/s3/aws4_request', signedHeaders: ['host', 'x-amz-date'], signature: 'a'.repeat(64) });
    expect(parseAuthorization('Basic Zm9v')).toBeNull();
  });
});
