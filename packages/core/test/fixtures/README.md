# Historical graph schemas

`historical-schemas.json` retains the normalized schema records used by the
compiler, importer, topology, canvas and environment-stamp regression fixtures.
The records preserve historical port ids such as `out0`, declaration order,
widget defaults, controller policy and dynamic constructs. Their provenance is
the recorded schema fixture and decoder at commit
`f31d44f007df64bec6ba0aaff0888e0493cb1c2c`.

These are test inputs, not a current server catalog, native schema capture,
compatibility decoder or runtime parity claim. Production discovery continues
to use the native schema wire. Tests of native decoding use native wire
payloads separately; ordinary graph regressions do not need a legacy protocol
parser to reconstruct their inputs.
