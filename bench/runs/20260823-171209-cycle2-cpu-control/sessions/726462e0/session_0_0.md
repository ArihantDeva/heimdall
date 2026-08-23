# session sharegpt_SYm10tk_0 — 2023-05-20 (2023/05/20 (Sat) 03:38)

date: 2023/05/20 (Sat) 03:38
iso_date: 2023-05-20

user: hi

assistant: Hello! How can I assist you today?

user: i have a table with the following rows:
O-22-040-ART13-PI3-K08
O-22-082-ART13-PI3-K09
O-22-048-ART13-PI3-K010
O-22-082-ART13-PI3-K011
O-22-055-ART12-PI4-K08
O-22-040-ART12-PI4-K09
O-22-073-ART4-PI4-K01
O-22-073-ART4-PI4-K02

I have to transform the data using a power BI DAX formula. 
The count of the characters in each line should be 22.
The format should be something like 
O-22-056-ART12-PI4-K02
O-22-055-ART12-PI4-K03
O-22-055-ART12-PI4-K04

some of the formulas have a wrong format, such as 
O-22-082-ART13-PI3-K011, which should be O-22-082-ART13-PI3-K11 or
O-22-073-ART4-PI4-K01, which should be O-22-073-ART04-PI4-K01.

How can i transform the column using power bi DAX logic?

assistant: You can use the following DAX formula in Power BI to transform the column:
```less
New Column = 
IF(
    LEN(Table1[Column]) = 22,     // Check if the length of the string is 22
    Table1[Column],               // If it is already in the correct format, leave it as is
    CONCATENATE(                  // Otherwise, transform it to the correct format
        LEFT(Table1[Column], 7),  // Take the first 7 characters (O-22-XXX-)
        IF(
            LEN(Table1[Column]) = 24,      // If the length is 24, there is a leading zero that needs to be removed
            CONCATENATE("ART", MID(Table1[Column], 11, 2)),   // Take the two characters after the "ART" (e.g. "13")
            CONCATENATE("ART0", MID(Table1[Column], 11, 1))  // Add a leading zero and take the one character after the "ART" (e.g. "4")
        ),
        MID(Table1[Column], 14, 6)    // Take the six characters after the "PI" (e.g. "4-K01")
    )
)
```
This formula first checks if the length of the string is already 22 characters. If it is, it leaves it as is. If not, it transforms the string to the correct format using the `LEFT`, `MID`, and `CONCATENATE` functions.

In particular, the formula checks whether there is a leading zero before the ART code, and adds it if necessary. It then combines the first 7 characters with the corrected ART code and the last 6 characters to form the final string.

You can replace "New Column" with the name of the column where you want to output the transformed values, and "Table1[Column]" with the name of the column that contains the original values.

user: the formula creates a syntax error. CONCATENATE() seems to only take two arguments

assistant: I apologize for the error in my previous response. You are correct that the `CONCATENATE()` function can only take two arguments in DAX. Here is an updated version of the formula that uses the `&` operator to concatenate strings instead:
```scss
New Column =
IF(
    LEN(Table1[Column]) = 22,     // Check if the length of the string is 22
    Table1[Column],               // If it is already in the correct format, leave it as is
    LEFT(Table1[Column], 7) &     // Take the first 7 characters (O-22-XXX-)
    IF(
        LEN(Table1[Column]) = 24,      // If the length is 24, there is a leading zero that needs to be removed
        "ART" & MID(Table1[Column], 11, 2),   // Take the two characters after the "ART" (e.g. "13")
        "ART0" & MID(Table1[Column], 11, 1)  // Add a leading zero and take the one character after the "ART" (e.g. "4")
    ) &
    MID(Table1[Column], 14, 6)    // Take the six characters after the "PI" (e.g. "4-K01")
)
```
This formula should work without syntax errors. Again, you can replace "New Column" with the name of the column where you want to output the transformed values, and "Table1[Column]" with the name of the column that contains the original values.

user: in your example O-22-XXX- has only 7 characters, but it has 9, please count every letter or string as a character and correct the formula

assistant: I apologize for the mistake in my previous response. Here is an updated version of the formula that takes into account the fact that "O-22-XXX-" has 9 characters:
```scss
New Column =
IF(
    LEN(Table1[Column]) = 22,     // Check if the length of the string is 22
    Table1[Column],               // If it is already in the correct format, leave it as is
    LEFT(Table1[Column], 9) &     // Take the first 9 characters (O-22-XXX-)
    IF(
        LEN(Table1[Column]) = 24,      // If the length is 24, there is a leading zero that needs to be removed
        "ART" & MID(Table1[Column], 12, 2),   // Take the two characters after the "ART" (e.g. "13")
        "ART0" & MID(Table1[Column], 12, 1)  // Add a leading zero and take the one character after the "ART" (e.g. "4")
    ) &
    MID(Table1[Column], 15, 6)    // Take the six characters after the "PI" (e.g. "4-K01")
)
```
This formula should work correctly for your case. Again, you can replace "New Column" with the name of the column where you want to output the transformed values, and "Table1[Column]" with the name of the column that contains the original values.

user: please replace Table1[Column] with ObjectiveName and account for the fact that my examples didnt show 24 characters, but 23.

assistant: Sure, here's the updated formula that uses "ObjectiveName" instead of "Table1[Column]" and takes into account that your examples have 23 characters instead of 24:
```scss
New Column =
IF(
    LEN(ObjectiveName) = 22,     // Check if the length of the string is 22
    ObjectiveName,               // If it is already in the correct format, leave it as is
    LEFT(ObjectiveName, 9) &     // Take the first 9 characters (O-22-XXX-)
    IF(
        LEN(ObjectiveName) = 23,      // If the length is 23, there is a leading zero that needs to be removed
        "ART" & MID(ObjectiveName, 12, 2),   // Take the two characters after the "ART" (e.g. "13")
        "ART0" & MID(ObjectiveName, 12, 1)  // Add a leading zero and take the one character after the "ART" (e.g. "4")
    ) &
    MID(ObjectiveName, 14, 6)    // Take the six characters after the "PI" (e.g. "4-K01")
)
```
Again, you can replace "New Column" with the name of the column where you want to output the transformed values, and "ObjectiveName" with the name of the column that contains the original values.
