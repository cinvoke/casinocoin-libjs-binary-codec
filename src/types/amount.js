const _ = require('lodash');
const assert = require('assert');
const BN = require('bn.js');
const Decimal = require('decimal.js');
const makeClass = require('../utils/make-class');
const { SerializedType } = require('./serialized-type');
const { bytesToHex } = require('../utils/bytes-utils');
const { Currency } = require('./currency');
const { AccountID } = require('./account-id');
const { UInt64 } = require('./uint-64');

const MIN_IOU_EXPONENT = -96;
const MAX_IOU_EXPONENT = 80;
const MAX_IOU_PRECISION = 16;
const MIN_IOU_MANTISSA = '1000' + '0000' + '0000' + '0000'; // 16 digits
const MAX_IOU_MANTISSA = '9999' + '9999' + '9999' + '9999'; // ..
const MAX_IOU = new Decimal(`${MAX_IOU_MANTISSA}e${MAX_IOU_EXPONENT}`);
const MIN_IOU = new Decimal(`${MIN_IOU_MANTISSA}e${MIN_IOU_EXPONENT}`);
const DROPS_PER_CSC = new Decimal('1e8');
const MAX_NETWORK_DROPS = new Decimal(4 * new Decimal('1e18'));
const MIN_CSC = new Decimal('1e-8');
const MAX_CSC = MAX_NETWORK_DROPS.dividedBy(DROPS_PER_CSC);

// Never use exponential form
Decimal.config({
    toExpPos: MAX_IOU_EXPONENT + MAX_IOU_PRECISION,
    toExpNeg: MIN_IOU_EXPONENT - MAX_IOU_PRECISION
});

const AMOUNT_PARAMETERS_DESCRIPTION = `
Native values must be described in drops, a 100 million of which equal one CSC.
This must be an integer number, with the absolute value not exceeding \
${MAX_NETWORK_DROPS}

IOU values must have a maximum precision of ${MAX_IOU_PRECISION} significant \
digits. They are serialized as\na canonicalised mantissa and exponent. 

The valid range for a mantissa is between ${MIN_IOU_MANTISSA} and \
${MAX_IOU_MANTISSA}
The exponent must be >= ${MIN_IOU_EXPONENT} and <= ${MAX_IOU_EXPONENT}

Thus the largest serializable IOU value is:
${MAX_IOU.toString()}

And the smallest:
${MIN_IOU.toString()}
`

function isDefined(val) {
    return !_.isUndefined(val);
}

function raiseIllegalAmountError(value) {
    throw new Error(`${value.toString()} is an illegal amount\n` +
        AMOUNT_PARAMETERS_DESCRIPTION);
}

const parsers = {
    string(str) {
        if (!str.match(/\d+/)) {
            raiseIllegalAmountError(str);
        }
        return [new Decimal(str).dividedBy(DROPS_PER_CSC), Currency.CSC];
    },
    object(object) {
        assert(isDefined(object.currency), 'currency must be defined');
        assert(isDefined(object.issuer), 'issuer must be defined');
        return [new Decimal(object.value),
            Currency.from(object.currency),
            AccountID.from(object.issuer)
        ];
    }
};

const Amount = makeClass({
    Amount(value, currency, issuer) {
        this.value = value || new Decimal('0');
        this.currency = currency || Currency.CSC;
        this.issuer = issuer || null;
        this.assertValueIsValid();
    },
    mixins: SerializedType,
    statics: {
        from(value) {
            if (value instanceof this) {
                return value;
            }
            const parser = parsers[typeof value];
            if (parser) {
                return new this(...parser(value));
            }
            throw new Error(`unsupported value: ${value}`);
        },
        fromParser(parser) {
            const mantissa = parser.read(8);
            const b1 = mantissa[0];
            const b2 = mantissa[1];

            const isIOU = b1 & 0x80;
            const isPositive = b1 & 0x40;
            const sign = isPositive ? '' : '-';

            if (isIOU) {
                mantissa[0] = 0;
                const currency = parser.readType(Currency);
                const issuer = parser.readType(AccountID);
                const exponent = ((b1 & 0x3F) << 2) + ((b2 & 0xff) >> 6) - 97;
                mantissa[1] &= 0x3F;
                // decimal.js won't accept e notation with hex
                const value = new Decimal(`${sign}0x${bytesToHex(mantissa)}`).times('1e' + exponent);
                return new this(value, currency, issuer);
            }

            mantissa[0] &= 0x3F;
            const drops = new Decimal(`${sign}0x${bytesToHex(mantissa)}`);
            const cscValue = drops.dividedBy(DROPS_PER_CSC);
            return new this(cscValue, Currency.CSC);
        }
    },
    assertValueIsValid() {
        // zero is always a valid amount value
        if (!this.isZero()) {
            if (this.isNative()) {
                const abs = this.value.abs();
                if (abs.lt(MIN_CSC) || abs.gt(MAX_CSC)) {
                    // value is in CSC scale, but show the value in canonical json form
                    raiseIllegalAmountError(this.value.times(DROPS_PER_CSC))
                }
            } else {
                const p = this.value.precision();
                const e = this.exponent();
                if (p > MAX_IOU_PRECISION ||
                    e > MAX_IOU_EXPONENT ||
                    e < MIN_IOU_EXPONENT) {
                    raiseIllegalAmountError(this.value)
                }
            }
        }
    },
    isNative() {
        return this.currency.isNative();
    },
    mantissa() {
        return new UInt64(
            new BN(this.value.times('1e' + -this.exponent()).abs().toString()));
    },
    isZero() {
        return this.value.isZero();
    },
    exponent() {
        return this.isNative() ? -8 : this.value.e - 15;
    },
    valueString() {
        return (this.isNative() ? this.value.times(DROPS_PER_CSC) : this.value)
            .toString();
    },
    toBytesSink(sink) {
        const isNative = this.isNative();
        const notNegative = !this.value.isNegative();
        const mantissa = this.mantissa().toBytes();

        if (isNative) {
            mantissa[0] |= notNegative ? 0x40 : 0;
            sink.put(mantissa);
        } else {
            mantissa[0] |= 0x80;
            if (!this.isZero()) {
                if (notNegative) {
                    mantissa[0] |= 0x40;
                }
                const exponent = this.value.e - 15;
                const exponentByte = 97 + exponent;
                mantissa[0] |= (exponentByte >>> 2);
                mantissa[1] |= (exponentByte & 0x03) << 6;
            }
            sink.put(mantissa);
            this.currency.toBytesSink(sink);
            this.issuer.toBytesSink(sink);
        }
    },
    toJSON() {
        const valueString = this.valueString();
        if (this.isNative()) {
            return valueString;
        }
        return {
            value: valueString,
            currency: this.currency.toJSON(),
            issuer: this.issuer.toJSON()
        };
    }
});

module.exports = {
    Amount
};