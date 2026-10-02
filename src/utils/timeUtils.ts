import { getISTDetails } from './indianMarketTime';

export const getIstTime = (): string => {
    const ist = getISTDetails();
    return `${ist.isoDate} ${ist.displayTime}`;
};

export * from './indianMarketTime';

