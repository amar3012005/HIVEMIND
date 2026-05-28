# Memory Audit — Last 12h
User: 54f5568b-4d6a-4ae1-9a33-48cb2909d59b
Window: 2026-05-26T23:09:00.522Z → 2026-05-27T11:09:00.606Z
Total: 133 memories

## Summary by type
- **canonical**: 8
- **bridge**: 19
- **fact**: 36
- **event**: 40
- **summary**: 30

## CANONICAL (8)

### Canonical fact: account:united-oil-&-gas-corp. (4 sources)
- id: `42d61c33` · type: synthesis · L · src: - conf=0.80 rev1 ev=3
- created: 2026-05-26T23:30:17.946Z
- key tags: sf-object:contact, synthesis:canonical, topic:account:united-oil-&-gas-corp., entity:Arthur_Song, entity:United_Oil_&_Gas_Corp., entity:Lauren_Boyle, entity:OrgFarm_EPIC, entity:Avi_Green

> Arthur Song is the CEO of United Oil & Gas Corp. (2026-05-26T23:30Z)

### Canonical fact: industry:energy (3 sources)
- id: `b9a879f6` · type: synthesis · L · src: - conf=0.90 rev1 ev=3
- created: 2026-05-26T23:29:02.036Z
- key tags: sf-object:account, synthesis:canonical, topic:industry:energy, entity:United_Oil_&_Gas, entity:UK, entity:Singapore, entity:United_States, entity:OrgFarm_EPIC

> United Oil & Gas has operations in the UK, Singapore, and the United States. (2026-05-26T23:29Z)

### Canonical fact: account (16 sources)
- id: `f6db6f1e` · type: synthesis · L · src: - conf=0.80 rev1 ev=3
- created: 2026-05-26T23:28:59.017Z
- key tags: sf-object:account, synthesis:canonical, topic:account, entity:OrgFarm_EPIC, entity:Pyramid_Construction_Inc., entity:Burlington_Textiles_Corp_of_America, entity:United_Oil_&_Gas,_UK, entity:USA

> OrgFarm EPIC is the owner of multiple accounts, including Pyramid Construction Inc., Burlington Textiles Corp of America, and United Oil & Gas, UK. (2026-05-26T23:28Z)

### Canonical fact: account:united-oil-&-gas-corp. (4 sources)
- id: `1cc26393` · type: synthesis · superseded · src: - conf=0.80 rev1 ev=3
- created: 2026-05-26T23:28:56.666Z
- key tags: sf-object:contact, synthesis:canonical, topic:account:united-oil-&-gas-corp., entity:Arthur_Song, entity:United_Oil_&_Gas_Corp., entity:Lauren_Boyle, entity:OrgFarm_EPIC, entity:Avi_Green

> Arthur Song is the CEO of United Oil & Gas Corp. (2026-05-26T23:28Z)

### Canonical fact: sf-object:contact (20 sources)
- id: `ef1f54a9` · type: synthesis · L · src: - conf=0.90 rev1 ev=3
- created: 2026-05-26T23:28:54.775Z
- key tags: sf-object:contact, synthesis:canonical, topic:sf-object:contact, entity:OrgFarm_EPIC, entity:United_Oil_&_Gas_Corp., entity:Edge_Communications, entity:Grand_Hotels_&_Resorts_Ltd., entity:University_of_Arizona

> OrgFarm EPIC is the owner of multiple contacts across different companies. (2026-05-26T23:28Z)

### Canonical fact: contact (20 sources)
- id: `c9a259a5` · type: synthesis · superseded · src: - conf=0.90 rev1 ev=3
- created: 2026-05-26T23:28:52.161Z
- key tags: sf-object:contact, synthesis:canonical, topic:contact, entity:OrgFarm_EPIC, entity:United_Oil_&_Gas_Corp., entity:Edge_Communications, entity:Grand_Hotels_&_Resorts_Ltd., entity:Jane_Grey

> OrgFarm EPIC is the owner of multiple accounts, including United Oil & Gas Corp., Edge Communications, and Grand Hotels & Resorts Ltd. (2026-05-26T23:28Z)

### Canonical fact: country:united states (5 sources)
- id: `d2903b2c` · type: synthesis · L · src: - conf=0.80 rev1 ev=3
- created: 2026-05-26T23:23:58.660Z
- key tags: sf-object:account, synthesis:canonical, topic:country:united states, entity:OrgFarm_EPIC, entity:United_States, entity:Edge_Communications, entity:Austin, entity:University_of_Arizona

> OrgFarm EPIC is the owner of multiple companies in the United States. (2026-05-26T23:23Z)

### Canonical fact: sf-object:account (10 sources)
- id: `c9bc4504` · type: synthesis · L · src: - conf=0.90 rev2 ev=5
- created: 2026-05-26T23:23:54.856Z
- key tags: sf-object:account, synthesis:canonical, topic:sf-object:account, entity:OrgFarm_EPIC, entity:United_Oil_&_Gas, entity:Singapore, entity:Edge_Communications, entity:United_States

> OrgFarm EPIC is the owner of multiple accounts, including United Oil & Gas, Singapore and Edge Communications. (2026-05-26T23:23Z)

## BRIDGE (19)

### Bridge: country:usa||industry:energy [conf=0.70]
- id: `a254d98f` · type: synthesis · L · src: - conf=0.70 rev1 ev=5
- created: 2026-05-26T23:58:51.489Z
- key tags: sf-object:account, synthesis:bridge, topic:country:usa||industry:energy, entity:United_Oil_&_Gas, entity:Burlington_Textiles_Corp_of_America, entity:Dickenson_plc, entity:OrgFarm_EPIC, entity:USA

> The energy industry, represented by United Oil & Gas, may have an enabling gap in the US market, where companies like Burlington Textiles Corp of America and Dickenson plc operate, as there is no direct connection or co-occurrence between the two clusters.

### Bridge: country:united states||sf-object:contact [conf=0.80]
- id: `3313ecf9` · type: synthesis · L · src: - conf=0.80 rev1 ev=4
- created: 2026-05-26T23:37:46.887Z
- key tags: sf-object:contact, sf-object:account, synthesis:bridge, topic:country:united states||sf-object:contact, entity:Cluster_A, entity:Cluster_B, entity:United_States, entity:Burlington_Textiles_Corp_of_America

> The contacts in Cluster A lack information about the companies' annual revenue and industry, which is available in Cluster B, creating an enabling gap for sales and marketing strategies. (2026-05-26T23:37Z)

### Bridge: contact||country:united states [conf=0.80]
- id: `f1dc681c` · type: synthesis · L · src: - conf=0.80 rev1 ev=4
- created: 2026-05-26T23:37:44.175Z
- key tags: sf-object:contact, sf-object:account, synthesis:bridge, topic:contact||country:united states, entity:Cluster_A, entity:Cluster_B, entity:United_States, entity:Edge_Communications

> The contacts in Cluster A lack information about the companies' annual revenue and industry, which is available in Cluster B, creating an enabling gap for sales and marketing strategies from 2026-05-18 to 2026-05-26. (2026-05-26T23:37Z)

### Bridge: account||account:sforce [conf=0.70]
- id: `a39d6ec8` · type: synthesis · L · src: - conf=0.70 rev1 ev=4
- created: 2026-05-26T23:37:40.595Z
- key tags: sf-object:contact, sf-object:account, synthesis:bridge, topic:account||account:sforce, entity:Jake_Llorrac, entity:Siddartha_Nedaerk, entity:Pyramid_Construction_Inc., entity:Burlington_Textiles_Corp_of_America

> The presence of contacts Jake Llorrac and Siddartha Nedaerk in the sForce account may indicate a need for more comprehensive account information, such as industry and annual revenue, which are available for other accounts like Pyramid Construction Inc. and Burlington Textiles Corp of America. (2026-05-26T23:37Z)

### Bridge: country:usa||sf-object:contact [conf=0.80]
- id: `470c2ef1` · type: synthesis · L · src: - conf=0.80 rev1 ev=4
- created: 2026-05-26T23:32:38.170Z
- key tags: sf-object:contact, sf-object:account, synthesis:bridge, topic:country:usa||sf-object:contact, entity:Burlington_Textiles_Corp_of_America, entity:Dickenson_plc, entity:Cluster_A, entity:Cluster_B

> The contacts in Cluster A lack information about their companies' billing countries, which is available in Cluster B for companies like Burlington Textiles Corp of America and Dickenson plc as of 2026-05-18. (2026-05-26T23:32Z)

### Bridge: country:united states||sf-object:contact [conf=0.80]
- id: `7c562a56` · type: synthesis · superseded · src: - conf=0.80 rev1 ev=4
- created: 2026-05-26T23:32:35.466Z
- key tags: sf-object:contact, sf-object:account, synthesis:bridge, topic:country:united states||sf-object:contact, entity:Cluster_A, entity:Cluster_B, entity:Burlington_Textiles_Corp_of_America, entity:Dickenson_plc

> The contacts in Cluster A lack information about the companies' annual revenue and industry, which is available in Cluster B, creating an enabling gap for sales and marketing strategies from 2026-05-18 to 2026-05-26. (2026-05-26T23:32Z)

### Bridge: account:sforce||sf-object:account [conf=0.80]
- id: `420b8435` · type: synthesis · L · src: - conf=0.80 rev1 ev=4
- created: 2026-05-26T23:32:32.558Z
- key tags: sf-object:contact, sf-object:account, synthesis:bridge, topic:account:sforce||sf-object:account, entity:Pyramid_Construction_Inc., entity:Burlington_Textiles_Corp_of_America, entity:Jake_Llorrac, entity:Siddartha_Nedaerk

> The accounts in Cluster B, such as Pyramid Construction Inc. and Burlington Textiles Corp of America, lack contact information, which is present in Cluster A for contacts like Jake Llorrac and Siddartha Nedaerk, indicating a potential enabling gap in sales or customer relationship management. (2026-05-26T23:32Z)

### Bridge: account||account:sforce [conf=0.80]
- id: `263bf384` · type: synthesis · superseded · src: - conf=0.80 rev1 ev=4
- created: 2026-05-26T23:32:29.271Z
- key tags: sf-object:contact, sf-object:account, synthesis:bridge, topic:account||account:sforce, entity:Pyramid_Construction_Inc., entity:Burlington_Textiles_Corp_of_America, entity:sForce, entity:Cluster_A

> The accounts in Cluster B, such as Pyramid Construction Inc. and Burlington Textiles Corp of America, lack contact information, which is present in Cluster A for the sForce account, indicating a potential enabling gap in customer relationship management. (2026-05-26T23:32Z)

### Bridge: contact||country:united states [conf=0.80]
- id: `3058a12f` · type: synthesis · superseded · src: - conf=0.80 rev1 ev=4
- created: 2026-05-26T23:30:25.302Z
- key tags: sf-object:contact, sf-object:account, synthesis:bridge, topic:contact||country:united states, entity:Cluster_A, entity:Cluster_B, entity:Burlington_Textiles_Corp_of_America, entity:Dickenson_plc

> The contacts in Cluster A lack information about the companies' annual revenues and industries, which are available in Cluster B, creating an enabling gap for sales and marketing strategies. (2026-05-26T23:30Z)

### Bridge: account:united-oil-&-gas,-singapore||industry:energy [conf=0.80]
- id: `b42062dd` · type: synthesis · L · src: - conf=0.80 rev1 ev=5
- created: 2026-05-26T23:30:20.595Z
- key tags: sf-object:contact, sf-object:account, synthesis:bridge, topic:account:united-oil-&-gas,-singapore||industry:energy, entity:United_Oil_&_Gas, entity:Liz_D'Cruz, entity:Tom_Ripley, entity:Singapore

> United Oil & Gas, Singapore's contacts, such as Liz D'Cruz and Tom Ripley, may not be aware of the company's industry classification and global presence, including its UK and US counterparts, as of 2026-05-26.

### Bridge: contact||industry:energy [conf=0.70]
- id: `7d394fb3` · type: synthesis · L · src: - conf=0.70 rev1 ev=4
- created: 2026-05-26T23:29:25.696Z
- key tags: sf-object:contact, sf-object:account, synthesis:bridge, topic:contact||industry:energy, entity:United_Oil_&_Gas_Corp., entity:Cluster_A, entity:Cluster_B, entity:Ashley_James

> The contacts in Cluster A, particularly those from United Oil & Gas Corp., may be able to provide business opportunities for the companies in Cluster B, which are also in the energy industry, but there is a lack of direct connection between them.

### Observation: 🟡 [2026-05-26] The contacts
- id: `78e40469` · type: fact · L · src: observer rev1
- created: 2026-05-26T23:29:25.671Z
- key tags: sf-object:contact, sf-object:account, synthesis:bridge, topic:contact||industry:energy

> 🟡 [2026-05-26] The contacts

### Bridge: account:united-oil-&-gas-corp.||industry:energy [conf=0.70]
- id: `7a527c15` · type: synthesis · L · src: - conf=0.70 rev1 ev=4
- created: 2026-05-26T23:29:22.925Z
- key tags: sf-object:contact, sf-object:account, synthesis:bridge, topic:account:united-oil-&-gas-corp.||industry:energy, entity:United_Oil_&_Gas_Corp., entity:Avi_Green, entity:Arthur_Song, entity:Lauren_Boyle

> United Oil & Gas Corp.'s executive team, including Avi Green, Arthur Song, Lauren Boyle, and Stella Pavlova, may not be fully utilizing the company's industry position and resources to drive growth and innovation in the energy sector by 2026.

### Bridge: country:usa||sf-object:contact [conf=0.80]
- id: `9ec1dd01` · type: synthesis · superseded · src: - conf=0.80 rev1 ev=4
- created: 2026-05-26T23:29:20.185Z
- key tags: sf-object:contact, sf-object:account, synthesis:bridge, topic:country:usa||sf-object:contact, entity:Burlington_Textiles_Corp_of_America, entity:Dickenson_plc, entity:Cluster_A, entity:Cluster_B

> The contacts in Cluster A lack information about the companies' annual revenue and industry, which is available in Cluster B for companies like Burlington Textiles Corp of America and Dickenson plc as of 2026-05-18. (2026-05-26T23:29Z)

### Bridge: contact||country:usa [conf=0.70]
- id: `57c9b340` · type: synthesis · L · src: - conf=0.70 rev1 ev=4
- created: 2026-05-26T23:29:17.684Z
- key tags: sf-object:contact, sf-object:account, synthesis:bridge, topic:contact||country:usa, entity:Edge_Communications, entity:Cluster_A, entity:Cluster_B, entity:USA

> and Edge Communications, may require additional information about the companies they represent, such as those found in Cluster B, to effectively facilitate business operations in the USA, as evidenced by the lack of country-specific information in Cluster A and the presence of USA-based companies in Cluster B.

### Bridge: country:united states||sf-object:contact [conf=0.80]
- id: `c5aee005` · type: synthesis · superseded · src: - conf=0.80 rev1 ev=4
- created: 2026-05-26T23:29:14.990Z
- key tags: sf-object:contact, sf-object:account, synthesis:bridge, topic:country:united states||sf-object:contact, entity:Cluster_A, entity:Cluster_B, entity:United_States, entity:Edge_Communications

> The contacts in Cluster A lack information about the companies' annual revenues and industries, which are provided in Cluster B, creating an enabling gap for sales and marketing strategies. (2026-05-26T23:29Z)

### Bridge: contact||country:united states [conf=0.80]
- id: `fa27df8e` · type: synthesis · superseded · src: - conf=0.80 rev1 ev=4
- created: 2026-05-26T23:29:11.746Z
- key tags: sf-object:contact, sf-object:account, synthesis:bridge, topic:contact||country:united states, entity:Cluster_A, entity:Cluster_B, entity:United_States, entity:Pyramid_Construction_Inc.

> The contacts in Cluster A lack information about the companies' annual revenues and industries, which are available in Cluster B, creating an enabling gap for sales and marketing strategies.

### Bridge: account:sforce||sf-object:account [conf=0.80]
- id: `17a27837` · type: synthesis · superseded · src: - conf=0.80 rev1 ev=4
- created: 2026-05-26T23:29:09.102Z
- key tags: sf-object:contact, sf-object:account, synthesis:bridge, topic:account:sforce||sf-object:account, entity:Pyramid_Construction_Inc., entity:Burlington_Textiles_Corp_of_America, entity:Jake_Llorrac, entity:Siddartha_Nedaerk

> The accounts in Cluster B, such as Pyramid Construction Inc. and Burlington Textiles Corp of America, lack contact information, which is present in Cluster A for contacts like Jake Llorrac and Siddartha Nedaerk, indicating a potential enabling gap in sales or customer relationship management. (2026-05-26T23:29Z)

### Bridge: account||account:sforce [conf=0.80]
- id: `d4deb8c7` · type: synthesis · superseded · src: - conf=0.80 rev1 ev=4
- created: 2026-05-26T23:29:06.612Z
- key tags: sf-object:contact, sf-object:account, synthesis:bridge, topic:account||account:sforce, entity:sForce, entity:Cluster_A, entity:Cluster_B, entity:Siddartha_Nedaerk

> The accounts in Cluster B lack contact information, which is present in Cluster A for the sForce account, indicating a potential gap in data management. (2026-05-26T23:29Z)

## FACT (36)

### Contact: Jack Rogers
- id: `fe8b8362` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:06:26.134Z
- key tags: sf-object:contact, entity:Jack_Rogers, entity:Burlington_Textiles_Corp_of_America, entity:OrgFarm_EPIC

> Name: Jack Rogers Title: VP, Facilities AccountName: Burlington Textiles Corp of America Email: jrogers@burlington.com Phone: (336) 222-7000 MailingCountry: USA LeadSource: Web Id: 003gK00000gYq3MQAS FirstName: Jack LastName: Rogers AccountId: 001gK000013kMc7QAE Account: Burlington Textiles Corp of America OwnerId: 005gK00003vyYpFQAU Owner: OrgFarm

### Contact: Sean Forbes
- id: `c033a902` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:06:23.918Z
- key tags: sf-object:contact, entity:Sean_Forbes, entity:Edge_Communications, entity:OrgFarm_EPIC

> Name: Sean Forbes Title: CFO AccountName: Edge Communications Email: sean@edge.com Phone: (512) 757-6000 MobilePhone: (512) 757-4561 Department: Finance LeadSource: Trade Show Id: 003gK00000gYq3LQAS FirstName: Sean LastName: Forbes AccountId: 001gK000013kMc6QAE Account: Edge Communications OwnerId: 005gK00003vyYpFQAU Owner: OrgFarm EPIC LastModifie

### Contact: Jane Grey
- id: `8f463794` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:06:21.727Z
- key tags: sf-object:contact, entity:Jane_Grey, entity:University_of_Arizona

> Name: Jane Grey Title: Dean of Administration AccountName: University of Arizona Email: jane_gray@uoa.edu Phone: (520) 773-9050 MobilePhone: (520) 773-4539 Department: Administration LeadSource: Word of mouth Id: 003gK00000gYq3VQAS FirstName: Jane LastName: Grey AccountId: 001gK000013kMcDQAU Account: University of Arizona OwnerId: 005gK00003vyYpFQA

### Contact: Jake Llorrac
- id: `d803e56b` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:06:19.286Z
- key tags: sf-object:contact, entity:Jake_Llorrac, entity:sForce, entity:OrgFarm_EPIC

> Name: Jake Llorrac AccountName: sForce Id: 003gK00000gYq3dQAC FirstName: Jake LastName: Llorrac AccountId: 001gK000013kMcHQAU Account: sForce OwnerId: 005gK00003vyYpFQAU Owner: OrgFarm EPIC LastModifiedDate: 2026-05-18T23:22:58.000+0000 CreatedDate: 2026-05-18T23:22:58.000+0000 OwnerName: OrgFarm EPIC (2026-05-27T01:06Z)

### Contact: Siddartha Nedaerk
- id: `d3562aa0` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:06:16.946Z
- key tags: sf-object:contact, entity:Siddartha_Nedaerk, entity:sForce, entity:OrgFarm_EPIC, entity:US

> Name: Siddartha Nedaerk AccountName: sForce MailingCountry: US Id: 003gK00000gYq3cQAC FirstName: Siddartha LastName: Nedaerk AccountId: 001gK000013kMcHQAU Account: sForce OwnerId: 005gK00003vyYpFQAU Owner: OrgFarm EPIC LastModifiedDate: 2026-05-18T23:22:58.000+0000 CreatedDate: 2026-05-18T23:22:58.000+0000 OwnerName: OrgFarm EPIC (2026-05-27T01:06Z

### Contact: Avi Green
- id: `d30b2283` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:06:14.533Z
- key tags: sf-object:contact, entity:Avi_Green, entity:United_Oil_&_Gas_Corp.

> Name: Avi Green Title: CFO AccountName: United Oil & Gas Corp. Email: agreen@uog.com Phone: (212) 842-5500 MobilePhone: (212) 842-2383 Department: Finance LeadSource: Public Relations Id: 003gK00000gYq3bQAC FirstName: Avi LastName: Green AccountId: 001gK000013kMcBQAU Account: United Oil & Gas Corp. OwnerId: 005gK00003vyYpFQAU Owner: OrgFarm EPIC La

### Contact: Edna Frank
- id: `8f39328a` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:06:12.289Z
- key tags: sf-object:contact, entity:Edna_Frank, entity:GenePoint, entity:OrgFarm_EPIC

> Name: Edna Frank Title: VP, Technology AccountName: GenePoint Email: efrank@genepoint.com Phone: (650) 867-3450 MobilePhone: (650) 867-7686 Department: Technology LeadSource: Partner Id: 003gK00000gYq3aQAC FirstName: Edna LastName: Frank AccountId: 001gK000013kMcGQAU Account: GenePoint OwnerId: 005gK00003vyYpFQAU Owner: OrgFarm EPIC LastModifiedDat

### Contact: Liz D'Cruz
- id: `8d1b18eb` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:06:09.803Z
- key tags: sf-object:contact, entity:Liz_D'Cruz, entity:United_Oil_&_Gas,_Singapore

> Name: Liz D'Cruz Title: VP, Production AccountName: United Oil & Gas, Singapore Email: ldcruz@uog.com Phone: (650) 450-8810 MobilePhone: (650) 345-6637 Department: Production LeadSource: Public Relations Id: 003gK00000gYq3ZQAS FirstName: Liz LastName: D'Cruz AccountId: 001gK000013kMcFQAU Account: United Oil & Gas, Singapore OwnerId: 005gK00003vyYpF

### Contact: Tom Ripley
- id: `897b1e98` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:06:07.528Z
- key tags: sf-object:contact, entity:Tom_Ripley, entity:United_Oil_&_Gas,_Singapore

> Name: Tom Ripley Title: Regional General Manager AccountName: United Oil & Gas, Singapore Email: tripley@uog.com Phone: (650) 450-8810 MobilePhone: (650) 345-7636 Department: Executive Team LeadSource: Public Relations Id: 003gK00000gYq3YQAS FirstName: Tom LastName: Ripley AccountId: 001gK000013kMcFQAU Account: United Oil & Gas, Singapore OwnerId: 

### Contact: Ashley James
- id: `c9d4fae1` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:06:04.935Z
- key tags: sf-object:contact, entity:Ashley_James, entity:United_Oil_&_Gas,_UK, entity:OrgFarm_EPIC

> Name: Ashley James Title: VP, Finance AccountName: United Oil & Gas, UK Email: ajames@uog.com Phone: +44 191 4956203 MobilePhone: +44 191 3456234 Department: Finance LeadSource: Public Relations Id: 003gK00000gYq3XQAS FirstName: Ashley LastName: James AccountId: 001gK000013kMcEQAU Account: United Oil & Gas, UK OwnerId: 005gK00003vyYpFQAU Owner: Org

### Contact: Arthur Song
- id: `86af4da4` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:06:02.598Z
- key tags: sf-object:contact, entity:Arthur_Song, entity:United_Oil_&_Gas_Corp.

> Name: Arthur Song Title: CEO AccountName: United Oil & Gas Corp. Email: asong@uog.com Phone: (212) 842-5500 MobilePhone: (212) 842-4535 Department: Executive Team LeadSource: Public Relations Id: 003gK00000gYq3WQAS FirstName: Arthur LastName: Song AccountId: 001gK000013kMcBQAU Account: United Oil & Gas Corp. OwnerId: 005gK00003vyYpFQAU Owner: OrgFa

### Contact: Rose Gonzalez
- id: `83cb0245` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:06:00.003Z
- key tags: sf-object:contact, entity:Rose_Gonzalez, entity:Edge_Communications, entity:OrgFarm_EPIC

> Name: Rose Gonzalez Title: SVP, Procurement AccountName: Edge Communications Email: rose@edge.com Phone: (512) 757-6000 MobilePhone: (512) 757-9340 Department: Procurement LeadSource: Trade Show Id: 003gK00000gYq3KQAS FirstName: Rose LastName: Gonzalez AccountId: 001gK000013kMc6QAE Account: Edge Communications OwnerId: 005gK00003vyYpFQAU Owner: Org

### Contact: Josh Davis
- id: `c2e1f967` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:05:57.681Z
- key tags: sf-object:contact, entity:Josh_Davis, entity:Express_Logistics_and_Transport

> Name: Josh Davis Title: Director, Warehouse Mgmt AccountName: Express Logistics and Transport Email: j.davis@expressl&t.net Phone: (503) 421-7800 MobilePhone: (503) 421-4387 Department: Warehouse Mgmt LeadSource: Word of mouth Id: 003gK00000gYq3UQAS FirstName: Josh LastName: Davis AccountId: 001gK000013kMcCQAU Account: Express Logistics and Transpo

### Contact: Babara Levy
- id: `4a192df8` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:05:55.377Z
- key tags: sf-object:contact, entity:Babara_Levy, entity:Express_Logistics_and_Transport, entity:OrgFarm_EPIC

> Name: Babara Levy Title: SVP, Operations AccountName: Express Logistics and Transport Email: b.levy@expressl&t.net Phone: (503) 421-7800 MobilePhone: (503) 421-5451 Department: Operations LeadSource: Word of mouth Id: 003gK00000gYq3TQAS FirstName: Babara LastName: Levy AccountId: 001gK000013kMcCQAU Account: Express Logistics and Transport OwnerId: 

### Contact: Lauren Boyle
- id: `6dfe6216` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:05:53.042Z
- key tags: sf-object:contact, entity:Lauren_Boyle, entity:United_Oil_&_Gas_Corp., entity:OrgFarm_EPIC

> Name: Lauren Boyle Title: SVP, Technology AccountName: United Oil & Gas Corp. Email: lboyle@uog.com Phone: (212) 842-5500 MobilePhone: (212) 842-5611 Department: Technology LeadSource: Public Relations Id: 003gK00000gYq3SQAS FirstName: Lauren LastName: Boyle AccountId: 001gK000013kMcBQAU Account: United Oil & Gas Corp. OwnerId: 005gK00003vyYpFQAU O

### Contact: Stella Pavlova
- id: `9dee2a14` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:05:50.742Z
- key tags: sf-object:contact, entity:Stella_Pavlova, entity:United_Oil_&_Gas_Corp.

> Name: Stella Pavlova Title: SVP, Production AccountName: United Oil & Gas Corp. Email: spavlova@uog.com Phone: (212) 842-5500 MobilePhone: (212) 842-5501 Department: Production LeadSource: Public Relations Id: 003gK00000gYq3RQAS FirstName: Stella LastName: Pavlova AccountId: 001gK000013kMcBQAU Account: United Oil & Gas Corp. OwnerId: 005gK00003vyYp

### Contact: John Bond
- id: `f77172b0` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:05:49.177Z
- key tags: sf-object:contact, entity:John_Bond, entity:Grand_Hotels_&_Resorts_Ltd, entity:OrgFarm_EPIC

> Name: John Bond Title: VP, Facilities AccountName: Grand Hotels & Resorts Ltd Email: bond_john@grandhotels.com Phone: (312) 596-1000 MobilePhone: (312) 596-1563 Department: Facilities LeadSource: External Referral Id: 003gK00000gYq3QQAS FirstName: John LastName: Bond AccountId: 001gK000013kMcAQAU Account: Grand Hotels & Resorts Ltd OwnerId: 005gK00

### Contact: Tim Barr
- id: `50f0bf6d` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:05:46.756Z
- key tags: sf-object:contact, entity:Tim_Barr, entity:Grand_Hotels_&_Resorts_Ltd, entity:OrgFarm_EPIC

> Name: Tim Barr Title: SVP, Administration and Finance AccountName: Grand Hotels & Resorts Ltd Email: barr_tim@grandhotels.com Phone: (312) 596-1000 MobilePhone: (312) 596-1230 Department: Finance LeadSource: External Referral Id: 003gK00000gYq3PQAS FirstName: Tim LastName: Barr AccountId: 001gK000013kMcAQAU Account: Grand Hotels & Resorts Ltd Owner

### Contact: Andy Young
- id: `ee0e1a8f` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:05:44.457Z
- key tags: sf-object:contact, entity:Andy_Young, entity:Dickenson_plc, entity:OrgFarm_EPIC

> Name: Andy Young Title: SVP, Operations AccountName: Dickenson plc Email: a_young@dickenson.com Phone: (785) 241-6200 MobilePhone: (785) 265-5350 Department: Internal Operations MailingCountry: USA LeadSource: Purchased List Id: 003gK00000gYq3OQAS FirstName: Andy LastName: Young AccountId: 001gK000013kMc9QAE Account: Dickenson plc OwnerId: 005gK000

### Contact: Pat Stumuller
- id: `809e3d8d` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:05:42.247Z
- key tags: sf-object:contact, entity:Pat_Stumuller, entity:Pyramid_Construction_Inc., entity:OrgFarm_EPIC

> Name: Pat Stumuller Title: SVP, Administration and Finance AccountName: Pyramid Construction Inc. Email: pat@pyramid.net Phone: (014) 427-4427 MobilePhone: (014) 454-6364 Department: Finance MailingCountry: France Id: 003gK00000gYq3NQAS FirstName: Pat LastName: Stumuller AccountId: 001gK000013kMc8QAE Account: Pyramid Construction Inc. OwnerId: 005g

### Account: Pyramid Construction Inc.
- id: `2ac15464` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:05:34.082Z
- key tags: sf-object:account, entity:Pyramid_Construction_Inc., entity:OrgFarm_EPIC, entity:France, entity:Paris

> Name: Pyramid Construction Inc. Industry: Construction AnnualRevenue: 950000000 NumberOfEmployees: 2680 Type: Customer - Channel BillingCountry: France BillingCity: Paris Website: www.pyramid.com Phone: (014) 427-4427 Id: 001gK000013kMc8QAE OwnerId: 005gK00003vyYpFQAU Owner: OrgFarm EPIC LastModifiedDate: 2026-05-18T23:22:58.000+0000 CreatedDate: 2

### Account: Burlington Textiles Corp of America
- id: `339708af` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:05:31.708Z
- key tags: sf-object:account, entity:Burlington_Textiles_Corp_of_America, entity:OrgFarm_EPIC, entity:USA, entity:Burlington

> Name: Burlington Textiles Corp of America Industry: Apparel AnnualRevenue: 350000000 NumberOfEmployees: 9000 Type: Customer - Direct BillingCountry: USA BillingCity: Burlington Website: www.burlington.com Phone: (336) 222-7000 Id: 001gK000013kMc7QAE OwnerId: 005gK00003vyYpFQAU Owner: OrgFarm EPIC LastModifiedDate: 2026-05-18T23:22:58.000+0000 Creat

### Account: United Oil & Gas, UK
- id: `f2aa9d65` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:05:29.194Z
- key tags: sf-object:account, entity:United_Oil_&_Gas,_UK, entity:OrgFarm_EPIC

> Name: United Oil & Gas, UK Industry: Energy NumberOfEmployees: 24000 Type: Customer - Direct Website: http://www.uos.com Phone: +44 191 4956203 Id: 001gK000013kMcEQAU OwnerId: 005gK00003vyYpFQAU Owner: OrgFarm EPIC LastModifiedDate: 2026-05-18T23:22:58.000+0000 CreatedDate: 2026-05-18T23:22:58.000+0000 OwnerName: OrgFarm EPIC (2026-05-27T01:05Z)

### Account: Sample Account for Entitlements
- id: `b71e91f8` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:05:26.805Z
- key tags: sf-object:account, entity:Sample_Account_for_Entitlements, entity:Automated_Process, entity:OrgFarm_EPIC

> Name: Sample Account for Entitlements Id: 001gK000013kMcIQAU OwnerId: 005gK00003vyZ8cQAE Owner: Automated Process LastModifiedDate: 2026-05-18T23:22:58.000+0000 CreatedDate: 2026-05-18T23:22:58.000+0000 OwnerName: Automated Process (2026-05-27T01:05Z)

### Account: sForce
- id: `d4a15841` · type: fact · superseded · src: salesforce rev1
- created: 2026-05-27T01:05:25.277Z
- key tags: sf-object:account, entity:sForce, entity:OrgFarm_EPIC, entity:San_Francisco, entity:US

> Name: sForce BillingCountry: US BillingCity: San Francisco Website: www.sforce.com Phone: (415) 901-7000 Id: 001gK000013kMcHQAU OwnerId: 005gK00003vyYpFQAU Owner: OrgFarm EPIC LastModifiedDate: 2026-05-18T23:22:58.000+0000 CreatedDate: 2026-05-18T23:22:58.000+0000 OwnerName: OrgFarm EPIC (2026-05-27T01:05Z)

### Account: GenePoint
- id: `867fc4ce` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:05:22.787Z
- key tags: sf-object:account, entity:GenePoint, entity:OrgFarm_EPIC, entity:United_States, entity:Mountain_View

> Name: GenePoint Industry: Biotechnology AnnualRevenue: 30000000 NumberOfEmployees: 265 Type: Customer - Channel BillingCountry: United States BillingCity: Mountain View Website: www.genepoint.com Phone: (650) 867-3450 Description: Genomics company engaged in mapping and sequencing of the human genome and developing gene-based drugs Id: 001gK000013k

### Account: United Oil & Gas, Singapore
- id: `2ed15288` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:05:21.366Z
- key tags: sf-object:account, entity:United_Oil_&_Gas, entity:Singapore, entity:OrgFarm_EPIC

> Name: United Oil & Gas, Singapore Industry: Energy NumberOfEmployees: 3000 Type: Customer - Direct BillingCity: Singapore Website: http://www.uos.com Phone: (650) 450-8810 Id: 001gK000013kMcFQAU OwnerId: 005gK00003vyYpFQAU Owner: OrgFarm EPIC LastModifiedDate: 2026-05-18T23:22:58.000+0000 CreatedDate: 2026-05-18T23:22:58.000+0000 OwnerName: OrgFarm

### Account: Edge Communications
- id: `93122455` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:05:19.002Z
- key tags: sf-object:account, entity:Edge_Communications, entity:OrgFarm_EPIC, entity:United_States, entity:Austin

> Name: Edge Communications Industry: Electronics AnnualRevenue: 139000000 NumberOfEmployees: 1000 Type: Customer - Direct BillingCountry: United States BillingCity: Austin Website: http://edgecomm.com Phone: (512) 757-6000 Description: Edge, founded in 1998, is a start-up based in Austin, TX. The company designs and manufactures a device to convert 

### Account: University of Arizona
- id: `e20bdf29` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:05:17.498Z
- key tags: sf-object:account, entity:University_of_Arizona, entity:OrgFarm_EPIC

> Name: University of Arizona Industry: Education NumberOfEmployees: 39000 Type: Customer - Direct BillingCountry: United States BillingCity: Tucson Website: www.universityofarizona.com Phone: (520) 773-9050 Description: Leading university in AZ offering undergraduate and graduate programs in arts and humanities, pure sciences, engineering, business,

### Account: Express Logistics and Transport
- id: `63939c79` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:05:15.361Z
- key tags: sf-object:account, entity:Express_Logistics_and_Transport, entity:OrgFarm_EPIC, entity:United_States, entity:Portland

> Name: Express Logistics and Transport Industry: Transportation AnnualRevenue: 950000000 NumberOfEmployees: 12300 Type: Customer - Channel BillingCountry: United States BillingCity: Portland Website: www.expressl&t.net Phone: (503) 421-7800 Description: Commerical logistics and transportation company. Id: 001gK000013kMcCQAU OwnerId: 005gK00003vyYpFQ

### Account: United Oil & Gas Corp.
- id: `6d23e786` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:05:13.116Z
- key tags: sf-object:account, entity:United_Oil_&_Gas_Corp., entity:OrgFarm_EPIC, entity:United_States, entity:New_York

> Name: United Oil & Gas Corp. Industry: Energy AnnualRevenue: 5600000000 NumberOfEmployees: 145000 Type: Customer - Direct BillingCountry: United States BillingCity: New York Website: http://www.uos.com Phone: (212) 842-5500 Description: World's third largest oil and gas company. Id: 001gK000013kMcBQAU OwnerId: 005gK00003vyYpFQAU Owner: OrgFarm EPIC

### Account: Grand Hotels & Resorts Ltd
- id: `7c59f1a1` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:05:11.584Z
- key tags: sf-object:account, entity:Grand_Hotels_&_Resorts_Ltd, entity:United_States, entity:Chicago, entity:UK, entity:Eastern_Europe, entity:Japan, entity:SE_Asia

> Name: Grand Hotels & Resorts Ltd Industry: Hospitality AnnualRevenue: 500000000 NumberOfEmployees: 5600 Type: Customer - Direct BillingCountry: United States BillingCity: Chicago Website: www.grandhotels.com Phone: (312) 596-1000 Description: Chain of hotels and resorts across the US, UK, Eastern Europe, Japan, and SE Asia. Id: 001gK000013kMcAQAU O

### Account: Dickenson plc
- id: `c2f1c9aa` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:05:09.950Z
- key tags: sf-object:account, entity:Dickenson_plc, entity:OrgFarm_EPIC, entity:USA, entity:Lawrence

> Name: Dickenson plc Industry: Consulting AnnualRevenue: 50000000 NumberOfEmployees: 120 Type: Customer - Channel BillingCountry: USA BillingCity: Lawrence Website: dickenson-consulting.com Phone: (785) 241-6200 Id: 001gK000013kMc9QAE OwnerId: 005gK00003vyYpFQAU Owner: OrgFarm EPIC LastModifiedDate: 2026-05-18T23:22:58.000+0000 CreatedDate: 2026-05-

### Account: B&B Markenagentur
- id: `74db31e1` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:05:07.695Z
- key tags: sf-object:account, entity:B&B_Markenagentur, entity:BLAIQ, entity:HiveMind, entity:AMR_SAI_GADDE, entity:Germany, entity:Hannover

> Name: B&B Markenagentur Industry: Marketing AnnualRevenue: 4200000 NumberOfEmployees: 45 Type: Customer - Channel BillingCountry: Germany BillingCity: Hannover Website: https://bundb.de Description: B&B agency, parent of BLAIQ. Distribution partner for HiveMind GTM in DACH. Id: 001gK000015JW5dQAG OwnerId: 005gK000044Qi3bQAC Owner: AMR SAI GADDE Las

### Account: Vinil Audit AI Inc
- id: `42fa1f6f` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:05:05.285Z
- key tags: sf-object:account, entity:Vinil_Audit_AI_Inc, entity:AMR_SAI_GADDE, entity:Netherlands, entity:Amsterdam, entity:HiveMind

> Name: Vinil Audit AI Inc Industry: Technology AnnualRevenue: 2500000 NumberOfEmployees: 18 Type: Customer - Direct BillingCountry: Netherlands BillingCity: Amsterdam Website: https://vinilaudit.com Description: Audit firm AI partnership target. Building IFRS-compliant chatbot powered by HiveMind memory. Id: 001gK000015J8BaQAK OwnerId: 005gK000044Qi

### Account: Cherry Ventures
- id: `6f85e28a` · type: fact · L · src: salesforce rev1
- created: 2026-05-27T01:05:02.895Z
- key tags: sf-object:account

> Name: Cherry Ventures Industry: Venture Capital AnnualRevenue: 0 NumberOfEmployees: 60 Type: Investor BillingCountry: Germany BillingCity: Berlin Website: https://cherry.vc Description: Tier-1 Berlin VC. Series A target for Davinci AI Q3 2026. Id: 001gK000015JW7FQAW OwnerId: 005gK000044Qi3bQAC Owner: AMR SAI GADDE LastModifiedDate: 2026-05-26T23:10

## EVENT (40)

### Opp Stage: Proposal/Price Quote (006gK00000IZ5wvQAD)
- id: `18032fe0` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:08:03.346Z
- key tags: sf-object:opportunityhistory, entity:GenePoint, entity:OrgFarm_EPIC, entity:University_of_Arizona, entity:United_Oil_&_Gas_Corp., entity:Express_Logistics_and_Transport, entity:Pyramid_Construction_Inc.

> StageName: Proposal/Price Quote Amount: 24000 CloseDate: 2026-09-15 Probability: 60 ForecastCategory: Pipeline CreatedDate: 2026-05-26T23:10:46.000+0000 Id: 008gK00000Tqj5BQAR OpportunityId: 006gK00000IZ5wvQAD CreatedById: 005gK000044Qi3bQAC (2026-05-27T01:08Z)

### Opp Stage: Prospecting (006gK00000IZ609QAD)
- id: `cbc579ff` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:08:00.903Z
- key tags: sf-object:opportunityhistory, entity:Pyramid_Construction_Inc., entity:Express_Logistics_and_Transport, entity:Cherry_Ventures, entity:Edge_Communications, entity:GenePoint, entity:OrgFarm_EPIC, entity:AMR_SAI_GADDE

> StageName: Prospecting Amount: 1500000 CloseDate: 2026-10-30 Probability: 25 ForecastCategory: Pipeline CreatedDate: 2026-05-26T23:10:47.000+0000 Id: 008gK00000Tqj8PQAR OpportunityId: 006gK00000IZ609QAD CreatedById: 005gK000044Qi3bQAC (2026-05-27T01:07Z)

### Opp Stage: Negotiation/Review (006gK00000IZ5yXQAT)
- id: `64a5b3e2` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:07:58.303Z
- key tags: sf-object:opportunityhistory, entity:Express_Logistics_and_Transport, entity:United_Oil_&_Gas_Corp., entity:B&B_Markenagentur, entity:OrgFarm_EPIC, entity:AMR_SAI_GADDE

> StageName: Negotiation/Review Amount: 150000 CloseDate: 2026-08-01 Probability: 70 ForecastCategory: Pipeline CreatedDate: 2026-05-26T23:10:47.000+0000 Id: 008gK00000Tqj6nQAB OpportunityId: 006gK00000IZ5yXQAT CreatedById: 005gK000044Qi3bQAC (2026-05-27T01:07Z)

### Opp: Express Logistics Standby Generator
- id: `b6d4ea9d` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:07:54.254Z
- key tags: sf-object:opportunity, entity:Express_Logistics_and_Transport, entity:OrgFarm_EPIC

> Name: Express Logistics Standby Generator AccountName: Express Logistics and Transport StageName: Closed Won Amount: 220000 CloseDate: 2026-02-07 ForecastCategoryName: Closed Probability: 100 OwnerName: OrgFarm EPIC Type: New Customer LeadSource: Trade Show Id: 006gK00000IF0jlQAD AccountId: 001gK000013kMcCQAU Account: Express Logistics and Transpor

### Opp: United Oil Office Portable Generators
- id: `eff6aa46` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:07:51.598Z
- key tags: sf-object:opportunity, entity:United_Oil_&_Gas_Corp., entity:OrgFarm_EPIC

> Name: United Oil Office Portable Generators AccountName: United Oil & Gas Corp. StageName: Negotiation/Review Amount: 125000 CloseDate: 2026-03-14 ForecastCategoryName: Pipeline Probability: 90 OwnerName: OrgFarm EPIC Type: Existing Customer - Upgrade Id: 006gK00000IF0jkQAD AccountId: 001gK000013kMcBQAU Account: United Oil & Gas Corp. OwnerId: 005g

### Opp: United Oil Installations
- id: `adef23d5` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:07:49.178Z
- key tags: sf-object:opportunity, entity:United_Oil_Installations, entity:United_Oil_&_Gas_Corp., entity:OrgFarm_EPIC

> Name: United Oil Installations AccountName: United Oil & Gas Corp. StageName: Closed Won Amount: 270000 CloseDate: 2026-03-09 ForecastCategoryName: Closed Probability: 100 OwnerName: OrgFarm EPIC Type: Existing Customer - Upgrade LeadSource: Partner Id: 006gK00000IF0k0QAD AccountId: 001gK000013kMcBQAU Account: United Oil & Gas Corp. OwnerId: 005gK0

### Opp: Edge Emergency Generator
- id: `335ec8dc` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:07:46.518Z
- key tags: sf-object:opportunity, entity:Edge_Communications, entity:OrgFarm_EPIC

> Name: Edge Emergency Generator AccountName: Edge Communications StageName: Id. Decision Makers Amount: 35000 CloseDate: 2026-05-19 ForecastCategoryName: Pipeline Probability: 60 OwnerName: OrgFarm EPIC Type: Existing Customer - Replacement Id: 006gK00000IF0kDQAT AccountId: 001gK000013kMc6QAE Account: Edge Communications OwnerId: 005gK00003vyYpFQAU 

### Opp: United Oil Plant Standby Generators
- id: `45ec42e7` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:07:43.941Z
- key tags: sf-object:opportunity, entity:United_Oil_&_Gas_Corp., entity:OrgFarm_EPIC

> Name: United Oil Plant Standby Generators AccountName: United Oil & Gas Corp. StageName: Needs Analysis Amount: 675000 CloseDate: 2026-04-07 ForecastCategoryName: Pipeline Probability: 20 OwnerName: OrgFarm EPIC Type: Existing Customer - Upgrade Id: 006gK00000IF0kCQAT AccountId: 001gK000013kMcBQAU Account: United Oil & Gas Corp. OwnerId: 005gK00003

### Opp: Grand Hotels Emergency Generators
- id: `3d1aeebe` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:07:41.237Z
- key tags: sf-object:opportunity, entity:Grand_Hotels_&_Resorts_Ltd, entity:OrgFarm_EPIC

> Name: Grand Hotels Emergency Generators AccountName: Grand Hotels & Resorts Ltd StageName: Closed Won Amount: 210000 CloseDate: 2026-04-24 ForecastCategoryName: Closed Probability: 100 OwnerName: OrgFarm EPIC Type: New Customer LeadSource: External Referral Id: 006gK00000IF0kBQAT AccountId: 001gK000013kMcAQAU Account: Grand Hotels & Resorts Ltd Own

### Opp: United Oil Standby Generators
- id: `d9abaed1` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:07:38.622Z
- key tags: sf-object:opportunity, entity:United_Oil_&_Gas_Corp., entity:OrgFarm_EPIC, entity:United_Oil_Standby_Generators

> Name: United Oil Standby Generators AccountName: United Oil & Gas Corp. StageName: Closed Won Amount: 120000 CloseDate: 2026-05-06 ForecastCategoryName: Closed Probability: 100 OwnerName: OrgFarm EPIC Type: Existing Customer - Upgrade LeadSource: External Referral Id: 006gK00000IF0kAQAT AccountId: 001gK000013kMcBQAU Account: United Oil & Gas Corp. 

### Opp: Grand Hotels SLA
- id: `f8d790f6` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:07:35.883Z
- key tags: sf-object:opportunity, entity:Grand_Hotels_&_Resorts_Ltd, entity:OrgFarm_EPIC

> Name: Grand Hotels SLA AccountName: Grand Hotels & Resorts Ltd StageName: Closed Won Amount: 90000 CloseDate: 2026-02-04 ForecastCategoryName: Closed Probability: 100 OwnerName: OrgFarm EPIC Type: Existing Customer - Upgrade LeadSource: External Referral Id: 006gK00000IF0k9QAD AccountId: 001gK000013kMcAQAU Account: Grand Hotels & Resorts Ltd OwnerI

### Opp: United Oil Emergency Generators
- id: `11212799` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:07:32.842Z
- key tags: sf-object:opportunity, entity:United_Oil_&_Gas_Corp., entity:OrgFarm_EPIC

> Name: United Oil Emergency Generators AccountName: United Oil & Gas Corp. StageName: Closed Won Amount: 440000 CloseDate: 2026-03-03 ForecastCategoryName: Closed Probability: 100 OwnerName: OrgFarm EPIC Type: Existing Customer - Upgrade LeadSource: External Referral Id: 006gK00000IF0k8QAD AccountId: 001gK000013kMcBQAU Account: United Oil & Gas Corp

### Opp: United Oil Installations
- id: `0220c430` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:07:30.322Z
- key tags: sf-object:opportunity, entity:United_Oil_Installations, entity:United_Oil_&_Gas_Corp., entity:OrgFarm_EPIC

> Name: United Oil Installations AccountName: United Oil & Gas Corp. StageName: Closed Won Amount: 235000 CloseDate: 2026-03-21 ForecastCategoryName: Closed Probability: 100 OwnerName: OrgFarm EPIC Type: Existing Customer - Upgrade LeadSource: External Referral Id: 006gK00000IF0k7QAD AccountId: 001gK000013kMcBQAU Account: United Oil & Gas Corp. Owner

### Opp: Burlington Textiles Weaving Plant Generator
- id: `ce2db8bb` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:07:27.483Z
- key tags: sf-object:opportunity, entity:Burlington_Textiles_Corp_of_America, entity:OrgFarm_EPIC

> Name: Burlington Textiles Weaving Plant Generator AccountName: Burlington Textiles Corp of America StageName: Closed Won Amount: 235000 CloseDate: 2026-03-19 ForecastCategoryName: Closed Probability: 100 OwnerName: OrgFarm EPIC Type: New Customer LeadSource: Web Id: 006gK00000IF0k6QAD AccountId: 001gK000013kMc7QAE Account: Burlington Textiles Corp 

### Opp: University of AZ SLA
- id: `5d6ac4bd` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:07:24.922Z
- key tags: sf-object:opportunity, entity:University_of_Arizona, entity:OrgFarm_EPIC

> Name: University of AZ SLA AccountName: University of Arizona StageName: Closed Won Amount: 90000 CloseDate: 2026-02-15 ForecastCategoryName: Closed Probability: 100 OwnerName: OrgFarm EPIC Type: Existing Customer - Upgrade LeadSource: Public Relations Id: 006gK00000IF0k5QAD AccountId: 001gK000013kMcDQAU Account: University of Arizona OwnerId: 005g

### Opp: Express Logistics SLA
- id: `d4f02740` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:07:22.397Z
- key tags: sf-object:opportunity, entity:Express_Logistics_and_Transport, entity:OrgFarm_EPIC

> Name: Express Logistics SLA AccountName: Express Logistics and Transport StageName: Perception Analysis Amount: 120000 CloseDate: 2026-02-06 ForecastCategoryName: Pipeline Probability: 70 OwnerName: OrgFarm EPIC Type: Existing Customer - Upgrade LeadSource: External Referral Id: 006gK00000IF0k4QAD AccountId: 001gK000013kMcCQAU Account: Express Logi

### Opp: University of AZ Installations
- id: `596cad28` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:07:20.143Z
- key tags: sf-object:opportunity, entity:University_of_Arizona, entity:OrgFarm_EPIC

> Name: University of AZ Installations AccountName: University of Arizona StageName: Proposal/Price Quote Amount: 100000 CloseDate: 2026-02-08 ForecastCategoryName: Pipeline Probability: 75 OwnerName: OrgFarm EPIC Type: Existing Customer - Upgrade LeadSource: Employee Referral Id: 006gK00000IF0k3QAD AccountId: 001gK000013kMcDQAU Account: University o

### Opp: United Oil Refinery Generators
- id: `06d902cc` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:07:17.622Z
- key tags: sf-object:opportunity, entity:United_Oil_Refinery_Generators, entity:United_Oil_&_Gas_Corp., entity:OrgFarm_EPIC

> Name: United Oil Refinery Generators AccountName: United Oil & Gas Corp. StageName: Closed Won Amount: 915000 CloseDate: 2026-04-21 ForecastCategoryName: Closed Probability: 100 OwnerName: OrgFarm EPIC Type: New Customer LeadSource: Partner Id: 006gK00000IF0k2QAD AccountId: 001gK000013kMcBQAU Account: United Oil & Gas Corp. OwnerId: 005gK00003vyYpF

### Opp: Grand Hotels Generator Installations
- id: `784eaaa3` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:07:15.052Z
- key tags: sf-object:opportunity, entity:Grand_Hotels_&_Resorts_Ltd, entity:OrgFarm_EPIC

> Name: Grand Hotels Generator Installations AccountName: Grand Hotels & Resorts Ltd StageName: Closed Won Amount: 350000 CloseDate: 2026-04-26 ForecastCategoryName: Closed Probability: 100 OwnerName: OrgFarm EPIC Type: Existing Customer - Upgrade LeadSource: External Referral Id: 006gK00000IF0k1QAD AccountId: 001gK000013kMcAQAU Account: Grand Hotels

### Opp: Dickenson Mobile Generators
- id: `cd3a08cf` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:07:12.666Z
- key tags: sf-object:opportunity, entity:Dickenson_Mobile_Generators, entity:Dickenson_plc, entity:OrgFarm_EPIC

> Name: Dickenson Mobile Generators AccountName: Dickenson plc StageName: Qualification Amount: 15000 CloseDate: 2026-03-26 ForecastCategoryName: Pipeline Probability: 10 OwnerName: OrgFarm EPIC Type: New Customer LeadSource: Purchased List Id: 006gK00000IF0jjQAD AccountId: 001gK000013kMc9QAE Account: Dickenson plc OwnerId: 005gK00003vyYpFQAU Owner: 

### Opp: Edge SLA
- id: `bb704ffd` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:07:09.913Z
- key tags: sf-object:opportunity, entity:Edge_Communications, entity:OrgFarm_EPIC

> Name: Edge SLA AccountName: Edge Communications StageName: Closed Won Amount: 60000 CloseDate: 2026-01-28 ForecastCategoryName: Closed Probability: 100 OwnerName: OrgFarm EPIC Type: Existing Customer - Upgrade LeadSource: Word of mouth Id: 006gK00000IF0jzQAD AccountId: 001gK000013kMc6QAE Account: Edge Communications OwnerId: 005gK00003vyYpFQAU Owne

### Opp: Edge Installation
- id: `2a3c1ab2` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:07:07.436Z
- key tags: sf-object:opportunity, entity:Edge_Communications, entity:OrgFarm_EPIC

> Name: Edge Installation AccountName: Edge Communications StageName: Closed Won Amount: 50000 CloseDate: 2026-03-04 ForecastCategoryName: Closed Probability: 100 OwnerName: OrgFarm EPIC Type: Existing Customer - Upgrade LeadSource: Word of mouth Id: 006gK00000IF0jyQAD AccountId: 001gK000013kMc6QAE Account: Edge Communications OwnerId: 005gK00003vyYp

### Opp: United Oil Installations
- id: `59f318e4` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:07:04.692Z
- key tags: sf-object:opportunity, entity:United_Oil_Installations, entity:United_Oil_&_Gas_Corp., entity:OrgFarm_EPIC

> Name: United Oil Installations AccountName: United Oil & Gas Corp. StageName: Negotiation/Review Amount: 270000 CloseDate: 2026-03-10 ForecastCategoryName: Pipeline Probability: 90 OwnerName: OrgFarm EPIC Type: Existing Customer - Upgrade Id: 006gK00000IF0jxQAD AccountId: 001gK000013kMcBQAU Account: United Oil & Gas Corp. OwnerId: 005gK00003vyYpFQA

### Opp: GenePoint SLA
- id: `54d81635` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:07:02.293Z
- key tags: sf-object:opportunity, entity:GenePoint, entity:OrgFarm_EPIC

> Name: GenePoint SLA AccountName: GenePoint StageName: Closed Won Amount: 30000 CloseDate: 2026-05-10 ForecastCategoryName: Closed Probability: 100 OwnerName: OrgFarm EPIC Type: Existing Customer - Upgrade LeadSource: Partner Id: 006gK00000IF0jwQAD AccountId: 001gK000013kMcGQAU Account: GenePoint OwnerId: 005gK00003vyYpFQAU Owner: OrgFarm EPIC LastM

### Opp: GenePoint Lab Generators
- id: `646e0b6c` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:06:59.916Z
- key tags: sf-object:opportunity, entity:GenePoint, entity:OrgFarm_EPIC

> Name: GenePoint Lab Generators AccountName: GenePoint StageName: Id. Decision Makers Amount: 60000 CloseDate: 2026-05-07 ForecastCategoryName: Pipeline Probability: 60 OwnerName: OrgFarm EPIC Id: 006gK00000IF0jvQAD AccountId: 001gK000013kMcGQAU Account: GenePoint OwnerId: 005gK00003vyYpFQAU Owner: OrgFarm EPIC LastModifiedDate: 2026-05-18T23:22:58.

### Opp: Express Logistics Portable Truck Generators
- id: `6d15d957` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:06:57.498Z
- key tags: sf-object:opportunity, entity:Express_Logistics_and_Transport, entity:OrgFarm_EPIC

> Name: Express Logistics Portable Truck Generators AccountName: Express Logistics and Transport StageName: Value Proposition Amount: 80000 CloseDate: 2026-02-05 ForecastCategoryName: Pipeline Probability: 50 OwnerName: OrgFarm EPIC Type: Existing Customer - Upgrade LeadSource: External Referral Id: 006gK00000IF0juQAD AccountId: 001gK000013kMcCQAU Ac

### Opp: Pyramid Emergency Generators
- id: `075beb73` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:06:55.139Z
- key tags: sf-object:opportunity, entity:Pyramid_Construction_Inc., entity:OrgFarm_EPIC

> Name: Pyramid Emergency Generators AccountName: Pyramid Construction Inc. StageName: Prospecting Amount: 100000 CloseDate: 2026-03-22 ForecastCategoryName: Pipeline Probability: 10 OwnerName: OrgFarm EPIC LeadSource: Phone Inquiry Id: 006gK00000IF0jtQAD AccountId: 001gK000013kMc8QAE Account: Pyramid Construction Inc. OwnerId: 005gK00003vyYpFQAU Own

### Opp: University of AZ Portable Generators
- id: `f325472e` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:06:52.676Z
- key tags: sf-object:opportunity, entity:University_of_Arizona, entity:OrgFarm_EPIC

> Name: University of AZ Portable Generators AccountName: University of Arizona StageName: Closed Won Amount: 50000 CloseDate: 2026-02-11 ForecastCategoryName: Closed Probability: 100 OwnerName: OrgFarm EPIC Type: New Customer LeadSource: Public Relations Id: 006gK00000IF0jsQAD AccountId: 001gK000013kMcDQAU Account: University of Arizona OwnerId: 005

### Opp: Edge Emergency Generator
- id: `e0517f0a` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:06:49.903Z
- key tags: sf-object:opportunity, entity:Edge_Communications, entity:OrgFarm_EPIC

> Name: Edge Emergency Generator AccountName: Edge Communications StageName: Closed Won Amount: 75000 CloseDate: 2026-05-13 ForecastCategoryName: Closed Probability: 100 OwnerName: OrgFarm EPIC Type: New Customer LeadSource: Word of mouth Id: 006gK00000IF0jrQAD AccountId: 001gK000013kMc6QAE Account: Edge Communications OwnerId: 005gK00003vyYpFQAU Own

### Opp: Grand Hotels Guest Portable Generators
- id: `e285e570` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:06:47.328Z
- key tags: sf-object:opportunity, entity:Grand_Hotels_&_Resorts_Ltd, entity:OrgFarm_EPIC

> Name: Grand Hotels Guest Portable Generators AccountName: Grand Hotels & Resorts Ltd StageName: Value Proposition Amount: 250000 CloseDate: 2026-05-13 ForecastCategoryName: Pipeline Probability: 50 OwnerName: OrgFarm EPIC Type: Existing Customer - Upgrade LeadSource: Employee Referral Id: 006gK00000IF0jqQAD AccountId: 001gK000013kMcAQAU Account: Gr

### Opp: United Oil SLA
- id: `b7e3ba21` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:06:44.553Z
- key tags: sf-object:opportunity, entity:United_Oil_&_Gas_Corp., entity:OrgFarm_EPIC

> Name: United Oil SLA AccountName: United Oil & Gas Corp. StageName: Closed Won Amount: 120000 CloseDate: 2026-05-05 ForecastCategoryName: Closed Probability: 100 OwnerName: OrgFarm EPIC Type: Existing Customer - Upgrade LeadSource: Partner Id: 006gK00000IF0jpQAD AccountId: 001gK000013kMcBQAU Account: United Oil & Gas Corp. OwnerId: 005gK00003vyYpFQ

### Opp: United Oil Refinery Generators
- id: `9c309a4f` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:06:41.880Z
- key tags: sf-object:opportunity, entity:United_Oil_Refinery_Generators, entity:United_Oil_&_Gas_Corp., entity:OrgFarm_EPIC

> Name: United Oil Refinery Generators AccountName: United Oil & Gas Corp. StageName: Proposal/Price Quote Amount: 270000 CloseDate: 2026-04-28 ForecastCategoryName: Pipeline Probability: 75 OwnerName: OrgFarm EPIC Type: Existing Customer - Upgrade Id: 006gK00000IF0joQAD AccountId: 001gK000013kMcBQAU Account: United Oil & Gas Corp. OwnerId: 005gK0000

### Opp: Grand Hotels Kitchen Generator
- id: `22be8fb8` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:06:39.280Z
- key tags: sf-object:opportunity, entity:Grand_Hotels_&_Resorts_Ltd, entity:OrgFarm_EPIC

> Name: Grand Hotels Kitchen Generator AccountName: Grand Hotels & Resorts Ltd StageName: Id. Decision Makers Amount: 15000 CloseDate: 2026-02-02 ForecastCategoryName: Pipeline Probability: 60 OwnerName: OrgFarm EPIC Type: Existing Customer - Upgrade Id: 006gK00000IF0jnQAD AccountId: 001gK000013kMcAQAU Account: Grand Hotels & Resorts Ltd OwnerId: 005

### Opp: GenePoint Standby Generator
- id: `a610ca75` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:06:36.905Z
- key tags: sf-object:opportunity, entity:GenePoint, entity:OrgFarm_EPIC

> Name: GenePoint Standby Generator AccountName: GenePoint StageName: Closed Won Amount: 85000 CloseDate: 2026-03-17 ForecastCategoryName: Closed Probability: 100 OwnerName: OrgFarm EPIC Type: New Customer LeadSource: Partner Id: 006gK00000IF0jmQAD AccountId: 001gK000013kMcGQAU Account: GenePoint OwnerId: 005gK00003vyYpFQAU Owner: OrgFarm EPIC LastMo

### Opp: Vinil Audit AI — Pilot Q3
- id: `e7679b6d` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:06:35.181Z
- key tags: sf-object:opportunity, entity:Vinil_Audit_AI_Inc, entity:AMR_SAI_GADDE, entity:HiveMind

> Name: Vinil Audit AI — Pilot Q3 AccountName: Vinil Audit AI Inc StageName: Proposal/Price Quote Amount: 24000 CloseDate: 2026-09-15 ForecastCategoryName: Pipeline Probability: 60 OwnerName: AMR SAI GADDE NextStep: Confirm pricing tier + technical scope Description: 3-month HiveMind pilot for audit firm. 1K-3K EUR per audit OR 2K-8K EUR/mo flat. Id:

### Opp: Cherry Ventures Series A
- id: `8f987032` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:06:31.051Z
- key tags: sf-object:opportunity, entity:Cherry_Ventures, entity:AMR_SAI_GADDE, entity:B&B, entity:Vinil, entity:Berlin

> Name: Cherry Ventures Series A AccountName: Cherry Ventures StageName: Prospecting Amount: 1500000 CloseDate: 2026-10-30 ForecastCategoryName: Pipeline Probability: 25 OwnerName: AMR SAI GADDE NextStep: Berlin meet June 5 — present deck + pilot proof Description: Series A target. €1-2M at €4-5M pre-money. Need traction proof from B&B + Vinil pilots

### Opp: B&B DACH GTM Partnership
- id: `5d24cfc4` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:06:28.391Z
- key tags: sf-object:opportunity, entity:B&B_Markenagentur, entity:AMR_SAI_GADDE

> Name: B&B DACH GTM Partnership AccountName: B&B Markenagentur StageName: Negotiation/Review Amount: 150000 CloseDate: 2026-08-01 ForecastCategoryName: Pipeline Probability: 70 OwnerName: AMR SAI GADDE NextStep: Lock LOI terms — IP license + 18% rev share Description: Counter-LOI GTM-002 v3 FINAL. €150K investment for 10% at €1.5M pre-money. Id: 006

### Contact: Vinil Haridasan
- id: `eaa31c8b` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:05:39.764Z
- key tags: sf-object:contact, entity:Vinil_Haridasan, entity:Vinil_Audit_AI_Inc, entity:Malta_EU_Summit, entity:AMR_SAI_GADDE

> Name: Vinil Haridasan Title: Founder & CEO AccountName: Vinil Audit AI Inc Email: vinil@vinilaudit.com LeadSource: Partner Referral Description: Lead contact for audit AI partnership. Met at Malta EU Summit. Id: 003gK00000ht71hQAA FirstName: Vinil LastName: Haridasan AccountId: 001gK000015J8BaQAK Account: Vinil Audit AI Inc OwnerId: 005gK000044Qi3b

### Contact: Uwe Berger
- id: `d076c50d` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:05:38.129Z
- key tags: sf-object:contact, entity:Uwe_Berger, entity:B&B_Markenagentur, entity:AMR_SAI_GADDE

> Name: Uwe Berger Title: Managing Director AccountName: B&B Markenagentur Email: uwe@bundb.de LeadSource: Internship Description: MD of B&B. Counter-LOI under negotiation. Critical relationship. Id: 003gK00000hsvQMQAY FirstName: Uwe LastName: Berger AccountId: 001gK000015JW5dQAG Account: B&B Markenagentur OwnerId: 005gK000044Qi3bQAC Owner: AMR SAI G

### Contact: Felix Reichert
- id: `5fbb5a2c` · type: event · L · src: salesforce rev1
- created: 2026-05-27T01:05:36.674Z
- key tags: sf-object:contact, entity:Felix_Reichert, entity:Cherry_Ventures, entity:Berlin

> Name: Felix Reichert Title: Partner AccountName: Cherry Ventures Email: felix@cherry.vc LeadSource: Cold Email Description: Cherry Ventures partner. Meeting scheduled in Berlin June 5 for Series A. Id: 003gK00000hsu7iQAA FirstName: Felix LastName: Reichert AccountId: 001gK000015JW7FQAW Account: Cherry Ventures OwnerId: 005gK000044Qi3bQAC Owner: AMR

## SUMMARY (30)

### Canonical: salesforce (6 memories part 4/4)
- id: `8e3bf9df` · type: summary · L · src: - rev1
- created: 2026-05-26T23:58:53.105Z
- key tags: sf-object:account, entity:United_Oil_&_Gas_Corp., entity:OrgFarm_EPIC, entity:United_States, entity:New_York, entity:Grand_Hotels_&_Resorts_Ltd, entity:Chicago, entity:US

> Topic: salesforce (part 4/4) — Salesforce accounts cover various industries, including energy, hospitality, consulting, marketing, technology, and venture capital. [1] (2026-05-26) — Account: United Oil & Gas Corp. Name: United Oil & Gas Corp. Industry: Energy AnnualRevenue: 5600000000 NumberOfEmployees: 145000 Type: Customer - Direct BillingCountr

### Canonical: salesforce (10 memories part 3/4)
- id: `97eacbee` · type: summary · L · src: - rev1
- created: 2026-05-26T23:58:52.926Z
- key tags: sf-object:account, entity:Pyramid_Construction_Inc., entity:OrgFarm_EPIC, entity:France, entity:Paris, entity:Burlington_Textiles_Corp_of_America, entity:USA, entity:Burlington

> Topic: salesforce (part 3/4) — Salesforce accounts cover various industries, companies, and locations worldwide. [1] (2026-05-26) — Account: Pyramid Construction Inc. Name: Pyramid Construction Inc. Industry: Construction AnnualRevenue: 950000000 NumberOfEmployees: 2680 Type: Customer - Channel BillingCountry: France BillingCity: Paris Website: www

### Canonical: salesforce (10 memories part 2/4)
- id: `50078632` · type: summary · L · src: - rev1
- created: 2026-05-26T23:58:52.731Z
- key tags: sf-object:contact, entity:Arthur_Song, entity:United_Oil_&_Gas_Corp., entity:Rose_Gonzalez, entity:Edge_Communications, entity:OrgFarm_EPIC, entity:Josh_Davis, entity:Express_Logistics_and_Transport

> Topic: salesforce (part 2/4) — Salesforce memories cover various business contacts across different companies and departments. [1] (2026-05-26) — Contact: Arthur Song Name: Arthur Song Title: CEO AccountName: United Oil & Gas Corp. Email: asong@uog.com Phone: (212) 842-5500 MobilePhone: (212) 842-4535 Department: Executive Team LeadSource: Public R

### Canonical: salesforce (10 memories part 1/4)
- id: `51213257` · type: summary · L · src: - rev1
- created: 2026-05-26T23:58:52.491Z
- key tags: sf-object:contact, entity:Jack_Rogers, entity:Burlington_Textiles_Corp_of_America, entity:OrgFarm_EPIC, entity:Sean_Forbes, entity:Edge_Communications, entity:Jane_Grey, entity:University_of_Arizona

> Topic: salesforce (part 1/4) — Salesforce contacts cover various executives across industries, including finance, technology, and production. [1] (2026-05-26) — Contact: Jack Rogers Name: Jack Rogers Title: VP, Facilities AccountName: Burlington Textiles Corp of America Email: jrogers@burlington.com Phone: (336) 222-7000 MailingCountry: USA LeadSou

### Canonical: salesforce (6 memories part 4/4)
- id: `65eeb310` · type: summary · L · src: - rev1
- created: 2026-05-26T23:56:23.443Z
- key tags: sf-object:account, entity:United_Oil_&_Gas_Corp., entity:OrgFarm_EPIC, entity:United_States, entity:New_York, entity:Grand_Hotels_&_Resorts_Ltd, entity:Chicago, entity:US

> Topic: salesforce (part 4/4) — Salesforce accounts cover various industries, including energy, hospitality, consulting, marketing, technology, and venture capital. [1] (2026-05-26) — Account: United Oil & Gas Corp. Name: United Oil & Gas Corp. Industry: Energy AnnualRevenue: 5600000000 NumberOfEmployees: 145000 Type: Customer - Direct BillingCountr

### Canonical: salesforce (10 memories part 3/4)
- id: `9e2bf83a` · type: summary · L · src: - rev1
- created: 2026-05-26T23:56:23.247Z
- key tags: sf-object:account, entity:Pyramid_Construction_Inc., entity:OrgFarm_EPIC, entity:France, entity:Paris, entity:Burlington_Textiles_Corp_of_America, entity:USA, entity:Burlington

> Topic: salesforce (part 3/4) — Salesforce accounts cover various industries, companies, and locations worldwide. [1] (2026-05-26) — Account: Pyramid Construction Inc. Name: Pyramid Construction Inc. Industry: Construction AnnualRevenue: 950000000 NumberOfEmployees: 2680 Type: Customer - Channel BillingCountry: France BillingCity: Paris Website: www

### Canonical: salesforce (10 memories part 2/4)
- id: `63862168` · type: summary · L · src: - rev1
- created: 2026-05-26T23:56:23.059Z
- key tags: sf-object:contact, entity:Arthur_Song, entity:United_Oil_&_Gas_Corp., entity:Rose_Gonzalez, entity:Edge_Communications, entity:OrgFarm_EPIC, entity:Josh_Davis, entity:Express_Logistics_and_Transport

> Topic: salesforce (part 2/4) — Salesforce memories cover various business contacts and their company details. [1] (2026-05-26) — Contact: Arthur Song Name: Arthur Song Title: CEO AccountName: United Oil & Gas Corp. Email: asong@uog.com Phone: (212) 842-5500 MobilePhone: (212) 842-4535 Department: Executive Team LeadSource: Public Relations Id: 003g

### Canonical: salesforce (10 memories part 1/4)
- id: `4d6566b3` · type: summary · L · src: - rev1
- created: 2026-05-26T23:56:22.680Z
- key tags: sf-object:contact, entity:Jack_Rogers, entity:Burlington_Textiles_Corp_of_America, entity:OrgFarm_EPIC, entity:Sean_Forbes, entity:Edge_Communications, entity:Jane_Grey, entity:University_of_Arizona

> Topic: salesforce (part 1/4) — Salesforce contacts cover various professionals across industries, including finance, technology, and administration. [1] (2026-05-26) — Contact: Jack Rogers Name: Jack Rogers Title: VP, Facilities AccountName: Burlington Textiles Corp of America Email: jrogers@burlington.com Phone: (336) 222-7000 MailingCountry: USA 

### Canonical: salesforce (6 memories part 4/4)
- id: `b940f374` · type: summary · L · src: - rev1
- created: 2026-05-26T23:52:11.834Z
- key tags: sf-object:account, entity:United_Oil_&_Gas_Corp., entity:OrgFarm_EPIC, entity:United_States, entity:New_York, entity:Grand_Hotels_&_Resorts_Ltd, entity:Chicago, entity:US

> Topic: salesforce (part 4/4) — Salesforce accounts cover various industries, including energy, hospitality, consulting, marketing, technology, and venture capital. [1] (2026-05-26) — Account: United Oil & Gas Corp. Name: United Oil & Gas Corp. Industry: Energy AnnualRevenue: 5600000000 NumberOfEmployees: 145000 Type: Customer - Direct BillingCountr

### Canonical: salesforce (10 memories part 3/4)
- id: `3d9e66a0` · type: summary · L · src: - rev1
- created: 2026-05-26T23:52:11.629Z
- key tags: sf-object:account, entity:Pyramid_Construction_Inc., entity:OrgFarm_EPIC, entity:France, entity:Paris, entity:Burlington_Textiles_Corp_of_America, entity:USA, entity:Burlington

> Topic: salesforce (part 3/4) — Salesforce accounts cover various industries, companies, and locations worldwide, including construction, energy, and education. [1] (2026-05-26) — Account: Pyramid Construction Inc. Name: Pyramid Construction Inc. Industry: Construction AnnualRevenue: 950000000 NumberOfEmployees: 2680 Type: Customer - Channel Billing

### Canonical: salesforce (10 memories part 2/4)
- id: `1f0ab209` · type: summary · L · src: - rev1
- created: 2026-05-26T23:52:11.397Z
- key tags: sf-object:contact, entity:Arthur_Song, entity:United_Oil_&_Gas_Corp., entity:Rose_Gonzalez, entity:Edge_Communications, entity:OrgFarm_EPIC, entity:Josh_Davis, entity:Express_Logistics_and_Transport

> Topic: salesforce (part 2/4) — Salesforce contacts cover various executives across industries like oil, logistics, and hospitality. [1] (2026-05-26) — Contact: Arthur Song Name: Arthur Song Title: CEO AccountName: United Oil & Gas Corp. Email: asong@uog.com Phone: (212) 842-5500 MobilePhone: (212) 842-4535 Department: Executive Team LeadSource: Pub

### Canonical: salesforce (10 memories part 1/4)
- id: `1811add9` · type: summary · L · src: - rev1
- created: 2026-05-26T23:52:11.135Z
- key tags: sf-object:contact, entity:Jack_Rogers, entity:Burlington_Textiles_Corp_of_America, entity:OrgFarm_EPIC, entity:Sean_Forbes, entity:Edge_Communications, entity:Jane_Grey, entity:University_of_Arizona

> Topic: salesforce (part 1/4) — Salesforce contacts cover various executives across industries, including finance, technology, and oil and gas. [1] (2026-05-26) — Contact: Jack Rogers Name: Jack Rogers Title: VP, Facilities AccountName: Burlington Textiles Corp of America Email: jrogers@burlington.com Phone: (336) 222-7000 MailingCountry: USA LeadSo

### Canonical: salesforce (6 memories part 4/4)
- id: `ff8e3a08` · type: summary · L · src: - rev1
- created: 2026-05-26T23:37:48.870Z
- key tags: sf-object:account, entity:United_Oil_&_Gas_Corp., entity:OrgFarm_EPIC, entity:United_States, entity:New_York, entity:Grand_Hotels_&_Resorts_Ltd, entity:Chicago, entity:US

> Topic: salesforce (part 4/4) — Salesforce accounts cover various industries, including energy, hospitality, consulting, marketing, technology, and venture capital. [1] (2026-05-26) — Account: United Oil & Gas Corp. Name: United Oil & Gas Corp. Industry: Energy AnnualRevenue: 5600000000 NumberOfEmployees: 145000 Type: Customer - Direct BillingCountr

### Canonical: salesforce (10 memories part 3/4)
- id: `dc8462e2` · type: summary · L · src: - rev1
- created: 2026-05-26T23:37:48.690Z
- key tags: sf-object:account, entity:Pyramid_Construction_Inc., entity:OrgFarm_EPIC, entity:France, entity:Paris, entity:Burlington_Textiles_Corp_of_America, entity:USA, entity:Burlington

> Topic: salesforce (part 3/4) — Salesforce accounts cover various industries, companies, and locations worldwide. [1] (2026-05-26) — Account: Pyramid Construction Inc. Name: Pyramid Construction Inc. Industry: Construction AnnualRevenue: 950000000 NumberOfEmployees: 2680 Type: Customer - Channel BillingCountry: France BillingCity: Paris Website: www

### Canonical: salesforce (10 memories part 2/4)
- id: `dd7db710` · type: summary · L · src: - rev1
- created: 2026-05-26T23:37:48.497Z
- key tags: sf-object:contact, entity:Arthur_Song, entity:United_Oil_&_Gas_Corp., entity:Rose_Gonzalez, entity:Edge_Communications, entity:OrgFarm_EPIC, entity:Josh_Davis, entity:Express_Logistics_and_Transport

> Topic: salesforce (part 2/4) — Salesforce contacts cover various executives across industries, including oil, logistics, and hospitality. [1] (2026-05-26) — Contact: Arthur Song Name: Arthur Song Title: CEO AccountName: United Oil & Gas Corp. Email: asong@uog.com Phone: (212) 842-5500 MobilePhone: (212) 842-4535 Department: Executive Team LeadSourc

### Canonical: salesforce (10 memories part 1/4)
- id: `f8173b7b` · type: summary · L · src: - rev1
- created: 2026-05-26T23:37:48.255Z
- key tags: sf-object:contact, entity:Jack_Rogers, entity:Burlington_Textiles_Corp_of_America, entity:OrgFarm_EPIC, entity:Sean_Forbes, entity:Edge_Communications, entity:Jane_Grey, entity:University_of_Arizona

> Topic: salesforce (part 1/4) — Salesforce contacts cover various professionals across industries, including finance, technology, and administration. [1] (2026-05-26) — Contact: Jack Rogers Name: Jack Rogers Title: VP, Facilities AccountName: Burlington Textiles Corp of America Email: jrogers@burlington.com Phone: (336) 222-7000 MailingCountry: USA 

### Canonical: salesforce (6 memories part 4/4)
- id: `921beabb` · type: summary · L · src: - rev1
- created: 2026-05-26T23:32:39.851Z
- key tags: sf-object:account, entity:United_Oil_&_Gas_Corp., entity:OrgFarm_EPIC, entity:United_States, entity:New_York, entity:Grand_Hotels_&_Resorts_Ltd, entity:Chicago, entity:US

> Topic: salesforce (part 4/4) — Salesforce accounts cover various industries, including energy, hospitality, consulting, marketing, technology, and venture capital. [1] (2026-05-26) — Account: United Oil & Gas Corp. Name: United Oil & Gas Corp. Industry: Energy AnnualRevenue: 5600000000 NumberOfEmployees: 145000 Type: Customer - Direct BillingCountr

### Canonical: salesforce (10 memories part 3/4)
- id: `65a2f095` · type: summary · L · src: - rev1
- created: 2026-05-26T23:32:39.640Z
- key tags: sf-object:account, entity:Pyramid_Construction_Inc., entity:OrgFarm_EPIC, entity:France, entity:Paris, entity:Burlington_Textiles_Corp_of_America, entity:USA, entity:Burlington

> Topic: salesforce (part 3/4) — Salesforce accounts cover various industries, companies, and locations worldwide. [1] (2026-05-26) — Account: Pyramid Construction Inc. Name: Pyramid Construction Inc. Industry: Construction AnnualRevenue: 950000000 NumberOfEmployees: 2680 Type: Customer - Channel BillingCountry: France BillingCity: Paris Website: www

### Canonical: salesforce (10 memories part 2/4)
- id: `1d8e281e` · type: summary · L · src: - rev1
- created: 2026-05-26T23:32:39.456Z
- key tags: sf-object:contact, entity:Arthur_Song, entity:United_Oil_&_Gas_Corp., entity:Rose_Gonzalez, entity:Edge_Communications, entity:OrgFarm_EPIC, entity:Josh_Davis, entity:Express_Logistics_and_Transport

> Topic: salesforce (part 2/4) — Salesforce memories cover various business contacts across different companies and departments. [1] (2026-05-26) — Contact: Arthur Song Name: Arthur Song Title: CEO AccountName: United Oil & Gas Corp. Email: asong@uog.com Phone: (212) 842-5500 MobilePhone: (212) 842-4535 Department: Executive Team LeadSource: Public R

### Canonical: salesforce (10 memories part 1/4)
- id: `26486a34` · type: summary · L · src: - rev1
- created: 2026-05-26T23:32:39.191Z
- key tags: sf-object:contact, entity:Jack_Rogers, entity:Burlington_Textiles_Corp_of_America, entity:OrgFarm_EPIC, entity:Sean_Forbes, entity:Edge_Communications, entity:Jane_Grey, entity:University_of_Arizona

> Topic: salesforce (part 1/4) — Salesforce contacts cover various professionals across industries, including finance, technology, and administration. [1] (2026-05-26) — Contact: Jack Rogers Name: Jack Rogers Title: VP, Facilities AccountName: Burlington Textiles Corp of America Email: jrogers@burlington.com Phone: (336) 222-7000 MailingCountry: USA 

### Canonical: salesforce (6 memories part 4/4)
- id: `96f91597` · type: summary · L · src: - rev1
- created: 2026-05-26T23:30:28.939Z
- key tags: sf-object:account, entity:United_Oil_&_Gas_Corp., entity:OrgFarm_EPIC, entity:United_States, entity:New_York, entity:Grand_Hotels_&_Resorts_Ltd, entity:Chicago, entity:US

> Topic: salesforce (part 4/4) — Salesforce accounts cover various industries, including energy, hospitality, consulting, marketing, technology, and venture capital. [1] (2026-05-26) — Account: United Oil & Gas Corp. Name: United Oil & Gas Corp. Industry: Energy AnnualRevenue: 5600000000 NumberOfEmployees: 145000 Type: Customer - Direct BillingCountr

### Canonical: salesforce (10 memories part 3/4)
- id: `2f826f55` · type: summary · L · src: - rev1
- created: 2026-05-26T23:30:28.770Z
- key tags: sf-object:account, entity:Pyramid_Construction_Inc., entity:OrgFarm_EPIC, entity:France, entity:Paris, entity:Burlington_Textiles_Corp_of_America, entity:USA, entity:Burlington

> Topic: salesforce (part 3/4) — Salesforce accounts cover various industries, companies, and locations worldwide. [1] (2026-05-26) — Account: Pyramid Construction Inc. Name: Pyramid Construction Inc. Industry: Construction AnnualRevenue: 950000000 NumberOfEmployees: 2680 Type: Customer - Channel BillingCountry: France BillingCity: Paris Website: www

### Canonical: salesforce (10 memories part 2/4)
- id: `0ad42dbb` · type: summary · L · src: - rev1
- created: 2026-05-26T23:30:28.572Z
- key tags: sf-object:contact, entity:Arthur_Song, entity:United_Oil_&_Gas_Corp., entity:Rose_Gonzalez, entity:Edge_Communications, entity:OrgFarm_EPIC, entity:Josh_Davis, entity:Express_Logistics_and_Transport

> Topic: salesforce (part 2/4) — Salesforce memories cover various business contacts and their company details. [1] (2026-05-26) — Contact: Arthur Song Name: Arthur Song Title: CEO AccountName: United Oil & Gas Corp. Email: asong@uog.com Phone: (212) 842-5500 MobilePhone: (212) 842-4535 Department: Executive Team LeadSource: Public Relations Id: 003g

### Canonical: salesforce (10 memories part 1/4)
- id: `2122dc34` · type: summary · L · src: - rev1
- created: 2026-05-26T23:30:28.285Z
- key tags: sf-object:contact, entity:Jack_Rogers, entity:Burlington_Textiles_Corp_of_America, entity:OrgFarm_EPIC, entity:Sean_Forbes, entity:Edge_Communications, entity:Jane_Grey, entity:University_of_Arizona

> Topic: salesforce (part 1/4) — Salesforce contacts cover various professionals across industries, including finance, technology, and production. [1] (2026-05-26) — Contact: Jack Rogers Name: Jack Rogers Title: VP, Facilities AccountName: Burlington Textiles Corp of America Email: jrogers@burlington.com Phone: (336) 222-7000 MailingCountry: USA Lead

### Canonical: salesforce (6 memories part 4/4)
- id: `0f0e6a42` · type: summary · L · src: - rev1
- created: 2026-05-26T23:29:27.457Z
- key tags: sf-object:account, entity:United_Oil_&_Gas_Corp., entity:OrgFarm_EPIC, entity:United_States, entity:New_York, entity:Grand_Hotels_&_Resorts_Ltd, entity:Chicago, entity:US

> Topic: salesforce (part 4/4) — Salesforce accounts cover various industries, including energy, hospitality, consulting, marketing, technology, and venture capital. [1] (2026-05-26) — Account: United Oil & Gas Corp. Name: United Oil & Gas Corp. Industry: Energy AnnualRevenue: 5600000000 NumberOfEmployees: 145000 Type: Customer - Direct BillingCountr

### Canonical: salesforce (10 memories part 3/4)
- id: `ded8f8b7` · type: summary · L · src: - rev1
- created: 2026-05-26T23:29:27.256Z
- key tags: sf-object:account, entity:Pyramid_Construction_Inc., entity:OrgFarm_EPIC, entity:France, entity:Paris, entity:Burlington_Textiles_Corp_of_America, entity:USA, entity:Burlington

> Topic: salesforce (part 3/4) — Salesforce accounts cover various industries, companies, and locations worldwide, including construction, energy, and education. [1] (2026-05-26) — Account: Pyramid Construction Inc. Name: Pyramid Construction Inc. Industry: Construction AnnualRevenue: 950000000 NumberOfEmployees: 2680 Type: Customer - Channel Billing

### Canonical: salesforce (10 memories part 2/4)
- id: `29f87293` · type: summary · L · src: - rev1
- created: 2026-05-26T23:29:27.001Z
- key tags: sf-object:contact, entity:Arthur_Song, entity:United_Oil_&_Gas_Corp., entity:Rose_Gonzalez, entity:Edge_Communications, entity:OrgFarm_EPIC, entity:Josh_Davis, entity:Express_Logistics_and_Transport

> Topic: salesforce (part 2/4) — Salesforce memories cover various business contacts across different companies and departments. [1] (2026-05-26) — Contact: Arthur Song Name: Arthur Song Title: CEO AccountName: United Oil & Gas Corp. Email: asong@uog.com Phone: (212) 842-5500 MobilePhone: (212) 842-4535 Department: Executive Team LeadSource: Public R

### Canonical: salesforce (10 memories part 1/4)
- id: `1bda8b34` · type: summary · L · src: - rev1
- created: 2026-05-26T23:29:26.746Z
- key tags: sf-object:contact, entity:Jack_Rogers, entity:Burlington_Textiles_Corp_of_America, entity:OrgFarm_EPIC, entity:Sean_Forbes, entity:Edge_Communications, entity:Jane_Grey, entity:University_of_Arizona

> Topic: salesforce (part 1/4) — Salesforce contacts cover various professionals across industries, including finance, technology, and administration. [1] (2026-05-26) — Contact: Jack Rogers Name: Jack Rogers Title: VP, Facilities AccountName: Burlington Textiles Corp of America Email: jrogers@burlington.com Phone: (336) 222-7000 MailingCountry: USA 

### Canonical: salesforce (5 memories part 2/2)
- id: `e177b938` · type: summary · L · src: - rev1
- created: 2026-05-26T23:23:59.929Z
- key tags: sf-object:account, entity:Grand_Hotels_&_Resorts_Ltd, entity:OrgFarm_EPIC, entity:United_States, entity:Chicago, entity:US, entity:UK, entity:Eastern_Europe

> Topic: salesforce (part 2/2) — Salesforce accounts cover various industries, including hospitality, consulting, marketing, technology, and venture capital. [1] (2026-05-26) — Account: Grand Hotels & Resorts Ltd Name: Grand Hotels & Resorts Ltd Industry: Hospitality AnnualRevenue: 500000000 NumberOfEmployees: 5600 Type: Customer - Direct BillingCoun

### Canonical: salesforce (10 memories part 1/2)
- id: `b2035f6a` · type: summary · L · src: - rev1
- created: 2026-05-26T23:23:59.748Z
- key tags: sf-object:account, entity:Burlington_Textiles_Corp_of_America, entity:OrgFarm_EPIC, entity:USA, entity:Burlington, entity:United_Oil_&_Gas,_UK, entity:Sample_Account_for_Entitlements, entity:Automated_Process

> Topic: salesforce (part 1/2) — Salesforce accounts cover various industries, companies, and locations worldwide. [1] (2026-05-26) — Account: Burlington Textiles Corp of America Name: Burlington Textiles Corp of America Industry: Apparel AnnualRevenue: 350000000 NumberOfEmployees: 9000 Type: Customer - Direct BillingCountry: USA BillingCity: Burling

