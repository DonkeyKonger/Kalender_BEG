export type CustomerContactInput = {
  contact_type: string;
  name: string;
  phone: string | null;
  email: string | null;
};

export type CustomerContact = CustomerContactInput & {
  id: number;
  customer_id: number;
  created_at: string;
  updated_at: string;
};

export type CustomerEmailAddress = {
  email: string;
  label: string | null;
  source: string | null;
  created_at: string | null;
};

export type Customer = {
  id: number;
  company_name: string;
  address_street: string | null;
  address_house_number: string | null;
  address_postal_code: string | null;
  address_city: string | null;
  address_country: string | null;
  company_phone: string | null;
  project_lead_name: string | null;
  project_lead_phone: string | null;
  project_lead_email: string | null;
  is_active: boolean;
  contacts: CustomerContact[];
  email_addresses: CustomerEmailAddress[];
  created_at: string;
  updated_at: string;
};

export type CustomerCreate = {
  company_name: string;
  address_street: string | null;
  address_house_number: string | null;
  address_postal_code: string | null;
  address_city: string | null;
  address_country: string | null;
  company_phone: string | null;
  project_lead_name: string | null;
  project_lead_phone: string | null;
  project_lead_email: string | null;
  is_active: boolean;
  contacts: CustomerContactInput[];
};

export type CustomerUpdate = Partial<CustomerCreate>;

export type CustomerRemoveResponse = {
  action: "deleted";
  customer: Customer;
};
