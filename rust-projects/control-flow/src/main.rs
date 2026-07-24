use std::io;

fn main() {
    println!("Enter temperature");

    let mut temp = String::new();

    io::stdin()
        .read_line(&mut temp)
        .expect("Failed to read line");

    let temp: f32 = temp.trim().parse().expect("ff");

    println!("convert temp to fahrenheit(f) or convert to celsius(c)");

    let mut measure = String::new();
    io::stdin()
        .read_line(&mut measure)
        .expect("Failed to read line");

    let measure: char = measure.trim().parse().expect("ff");

    if measure == 'c' {
        let con: f32 = (5.0 / 9.0) * (temp - 32.0);
        println!("{con}C");
    } else if measure == 'f' {
        let con: f32 = ((9.0 / 5.0) * temp) + 32.0;
        println!("{con}F");
    } else {
        println!("huh");
    }
}
