import * as Immutable from 'immutable';
import {Currency, SUPPORTED_CURRENCIES} from './currency';
import {default as PDate} from './pdate';
import {TypedRecordClass} from './precord'; // Todo: remove this import once we can upgrade to Immutable.js 4+
import {assert, assertIsNumber, assertPositiveIntegerOrNull, MappableIterable, PRecord, ValidationContext} from './util';

export enum CategoryRulePeriod {
    Day = 2,
    Week = 3,
    Month = 4,
    Year = 5,
}

const allowedRuleValues: number[] = [CategoryRulePeriod.Day, CategoryRulePeriod.Week, CategoryRulePeriod.Month, CategoryRulePeriod.Year];

export interface CategoryRuleValues {
    amount?: number;
    startDate?: PDate|number|null;
    endDate?: PDate|number|null;
    repeatN?: number;
    period?: CategoryRulePeriod|null;
}
export interface CategoryRuleCleanValues extends CategoryRuleValues {
    startDate?: PDate|null;
    endDate?: PDate|null;
}

export class CategoryRule extends PRecord({
    amount: 0.0,
    /** Start date for this rule, if any. */
    startDate: null as PDate|null,
    /** End date for this rule, if any. Must be after startDate but need not be within the budget period. */
    endDate: null as PDate|null,
    /** repeatN: If this rule is "Repeat every 6 weeks", this will be 6. If period is null, this value is meaningless. */
    repeatN: 1,
    /** period: one of the CategoryRulePeriod values or null (for spending that happens on one day or randomly throughout the budget) */
    period: null as CategoryRulePeriod|null,

    // Possible future addition: round up to nearest business day, nearest Thursday, etc.

}) {
    constructor(values?: CategoryRuleValues) {
        super(CategoryRule.cleanArgs(values || {}));
    }
    /** Assertions to help enforce correct usage. */
    protected _checkInvariants() {
        assertIsNumber(this.amount);
        assertIsNumber(this.repeatN);
        assert((this.repeatN >>> 0) === this.repeatN, "repeatN must be a positive integer."); // tslint:disable-line:no-bitwise
        assert(this.startDate === null || this.startDate instanceof PDate);
        assert(this.endDate === null || this.endDate instanceof PDate);
        assert(this.period === null || allowedRuleValues.indexOf(this.period) !== -1, "period must be null or one of the allowed period constants.");
    }

    /**
     * countOccurrencesBetween: Based on this rule, determine how many times this amount is repeated
     * between dateBegin and DateEnd.
     *
     * For example, if startDate is 2014-01-01, endDate is null, repeatN is 1, and period is Month
     * (repeat every month from Jan 1, 2014 onward), then counOccurrencesBetween(2016-01-01, 2016-12-31)
     * will return 12.
     * @param {PDate} dateBegin - Start date of the period in question (inclusive)
     * @param {PDate} dateEnd - End date of the period in question (inclusive)
     * @returns {number}
     */
    public countOccurrencesBetween(dateBegin: PDate, dateEnd: PDate) {
        assert(dateBegin instanceof PDate);
        assert(dateEnd instanceof PDate);
        assert(dateEnd >= dateBegin);

        // Short circuit checks:
        if (this.startDate && dateEnd < this.startDate) {
            return 0; // This rule doesn't start until after the date range in question has ended.
        }
        if (this.endDate && dateBegin > this.endDate) {
            return 0; // This rule ended before the date range in question began
        }
        if (this.period === null) {
            // This is not a repeating rule. We only have to consider startDate and endDate, which we did just above.
            return 1;
        }

        // Step 1: Compute the # of occurrences between this.startDate (if set) and the earlier of [this.endDate, dateEnd]
        const firstDay = this.startDate || dateBegin;
        const lastDay = (this.endDate && this.endDate < dateEnd) ? this.endDate : dateEnd;
        const daysDiff = Math.max(0, (+lastDay) - (+firstDay)); // daysDiff should never be negative

        let result = null;
        if (this.period === CategoryRulePeriod.Day) {
            result = Math.floor(daysDiff / this.repeatN) + 1; // Never return a negative value
        } else if (this.period === CategoryRulePeriod.Week) {
            result = Math.floor(daysDiff / (this.repeatN * 7)) + 1;  // Note: we know repeatN > 0
        } else if (this.period === CategoryRulePeriod.Month) {
            const months = (lastDay.year - firstDay.year) * 12
                         + (lastDay.month - firstDay.month)
                         + (lastDay.day >= firstDay.day ? 1 : 0);
            result = Math.floor((months - 1) / this.repeatN) + 1; // Note that when repeatN = 1, this simplifies to 'result = months'
        } else if (this.period === CategoryRulePeriod.Year) {
            result = (
                (lastDay.year - firstDay.year) +
                (lastDay.month > firstDay.month || (lastDay.month === firstDay.month && lastDay.day >= firstDay.day) ? 1 : 0)
            );
        } else {
            throw new Error("invalid period");
        }

        // Step 2: if dateBegin falls after this.startDate, subtract the number of occurrences
        // between this.startDate and the day before dateBegin:
        if (firstDay < dateBegin) {
            result -= this.countOccurrencesBetween(firstDay, new PDate(+dateBegin - 1));
        }
        return result;
    }

    /**
     * Given a JS object which may be JSON-serializable, convert it to the proper
     * fully-typed, immutable representation required to initialize or modify
     * a CategoryRule object.
     *
     * The result of this function can be passed to the CategoryRule constructor
     * or to the .merge() method.
     *
     * @param {Object} values - Values for the fields of this CategoryRule
     * @returns {Object} - Cleaned values for the fields of this CategoryRule
     */
    public static cleanArgs(values: CategoryRuleValues) {
        values = Object.assign({}, values); // Don't modify the parameter; create a copy
        if (typeof values.startDate === 'number') {
            values.startDate = new PDate(values.startDate);
        }
        if (typeof values.endDate === 'number') {
            values.endDate = new PDate(values.endDate);
        }
        return values as CategoryRuleCleanValues;
    }
}

export interface CategoryValues {
    id?: number|null;
    name?: string;
    rules?: MappableIterable|null;
    notes?: string;
    currencyCode?: string;
    groupId?: number|null;
    metadata?: Immutable.Map<string, any>;
}
export interface CleanCategoryValues extends CategoryValues {
    rules?: Immutable.List<CategoryRule>|null;
}

/**
 * Category: Represents a category of spending, such as "Rent", "Groceries", "Insurance", etc.
 */
export class Category extends PRecord({
    id: null as number|null,
    name: "",
    /**
     * Rules: a set of Rule objects defining expected spending in this category such as "$10 per day"
     *
     * If rules === null, this is an "Automatic" category, which means that the total amount expected
     * to be spent over the budget period should be computed from existing + pending transactions
     * in this category
     *
     * If rules is a List (even an empty list), then it the total amount to be spent during the budget
     * is to be calculated based on the rules. (Or is $0 if the rules list is empty)
     */
    rules: null as Immutable.List<CategoryRule>|null,
    /** Notes - custom text editable by the user */
    notes: "",
    /** the ISO 4217 currency code */
    currencyCode: "USD",
    /** Which CategoryGroup this category belongs to. */
    groupId: null as number|null,
    /** Metadata - meaning depends on the user/application */
    metadata: Immutable.Map<string, any>(),
}) {
    constructor(values?: CategoryValues) {
        super(Category.cleanArgs(values || {}));
    }

    /** Assertions to help enforce correct usage. */
    protected _checkInvariants() {
        assertPositiveIntegerOrNull(this.id);
        assertPositiveIntegerOrNull(this.groupId);
        if (this.rules !== null) {
            assert(Immutable.List.isList(this.rules));
            this.rules.forEach(rule => { assert(rule instanceof CategoryRule); });
        }
        assert(this.currency instanceof Currency); // Check that currencyCode is valid.
        assert(Immutable.Map.isMap(this.metadata));
    }

    protected _validate(context: ValidationContext) {
        // Group must be valid
        const groups = context.budget.categoryGroups;
        if (this.groupId === null || !groups.has(this.groupId)) {
            context.addError(null, "Every Category must be assigned to a valid CategoryGroup.");
        }
        // Ensure that no rules overlap:
        if (this.rules !== null) {
            const rules = this.rules;
            rules.forEach((rule: CategoryRule, i: number) => {
                rules.forEach((otherRule: CategoryRule, j: number) => {
                    if (i !== j) {
                        const otherStartDate = otherRule.startDate || context.budget.startDate;
                        const otherEndDate = otherRule.endDate || context.budget.endDate;
                        if (rule.countOccurrencesBetween(otherStartDate, otherEndDate) !== 0) {
                            context.addError('rules', "A budget category's rules must not overlap.");
                        }
                    }
                });
            });
        }
    }

    /** Is this an "automatic" category (see 'rules' attribute)? */
    get isAutomatic(): boolean { return this.rules === null; }

    /** Get the currency of this category. */
    get currency(): Currency { return SUPPORTED_CURRENCIES[this.currencyCode]; }

    /**
     * Given a JS object which may be JSON-serializable, convert it to the proper
     * fully-typed, immutable representation required to initialize or modify
     * a Category object.
     *
     * The result of this function can be passed to the Category constructor
     * or to the .merge() method.
     *
     * @param {Object} values - Values for the fields of this category
     * @returns {Object} - Cleaned values for the fields of this category
     */
    public static cleanArgs(values: CategoryValues) {
        values = Object.assign({}, values); // Don't modify the parameter; create a copy
        if (values.rules !== undefined && values.rules !== null) {
            // 'rules' can be any iterable with CategoryRule-typed values or
            // objects used to initialize CategoryRule
            values.rules = Immutable.List<CategoryRule>(
                values.rules.map((r: any) => r instanceof CategoryRule ? r : new CategoryRule(r))
            );
        }
        if ('metadata' in values && !Immutable.Map.isMap(values.metadata)) {
            values.metadata = Immutable.fromJS(values.metadata);
        }
        return values as CleanCategoryValues;
    }
}

/**
 * CategoryGroup: Represents an ordered group of categories.
 */
export class CategoryGroup extends PRecord({
    /** Unique integer ID of this category group */
    id: null as number|null,
    /** The name of this category group */
    name: "",
}) {
}
